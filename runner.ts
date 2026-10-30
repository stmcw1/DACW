/**
 * ⚠️ 安全边界声明（极其重要）：
 * 本运行机（Runner）不是容器级沙盒——除非执行策略解析为 docker（见 sandbox.ts）。
 * 当前默认策略为 host（宿主直执）；docker 容器执行在 sandbox 分支开发。
 *
 *   - policy = 'host'（默认）：命令白名单仅用于防止命令注入（如防止写手传入
 *     `npm rm -rf /`），不具备隔离不受信任代码的能力。测试脚本（如 `npm test`）
 *     会执行写手生成的任意代码，这些代码拥有与当前 Node 进程相同的文件系统、
 *     网络和进程权限。
 *   - policy = 'docker'（可选，sandbox 分支）：测试在一次性容器内执行（无网络、只读
 *     根文件系统、非 root、cap-drop ALL、no-new-privileges、内存/CPU/进程数上限），
 *     工作区先复制到一次性暂存目录再挂载，宿主工作区本身不进入容器。
 *   - policy = 'blocked'：拒绝执行测试（fail-closed），绝不静默回退到宿主执行。
 *
 * host 模式下如果写手模型不可信，必须将本进程置于 Docker、虚拟机或 gVisor 等真正的
 * 沙盒中运行。审查者（无论模型还是人工）审计发生在测试执行之后，是侦探性控制，
 * 不是执行前的安全屏障。
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import { StringDecoder } from 'string_decoder';
import {
    TEST_TOOL_WHITELIST,
    buildDockerRunArgv,
    defaultImageForCommand,
    newContainerName,
    resolveDockerExecutable,
} from './sandbox';
import type { ExecutionPolicy } from './sandbox';

export interface RunResult {
    success: boolean;
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    truncated: boolean;
}

interface SpawnCollectOptions {
    file: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    /** POSIX 下是否以独立进程组启动（宿主路径沿用旧行为；docker CLI 不需要）。 */
    detachGroup: boolean;
    /** 超时强杀后的额外清理（docker 模式：`docker rm -f` 兜底删除容器）。 */
    extraKill?: () => void;
}

export class Runner {
    private workspaceDir: string;
    private policy: ExecutionPolicy;
    private readonly MAX_OUTPUT_CHARS = 50_000;
    private readonly HARD_LIMIT_CHARS = 100_000;
    private readonly KILL_GRACE_MS = 2_000;
    private readonly EXIT_GRACE_MS = 1_500;
    private static readonly CMD_META = /[&|<>^%!"\r\n]/;

    private static readonly SHIM_CLI: Record<string, string[]> = {
        npm: ['node_modules', 'npm', 'bin', 'npm-cli.js'],
        npx: ['node_modules', 'npm', 'bin', 'npx-cli.js'],
        pnpm: ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'],
        yarn: ['node_modules', 'yarn', 'bin', 'yarn.js'],
    };

    constructor(workspaceDir: string, policy: ExecutionPolicy = { kind: 'host' }) {
        this.workspaceDir = path.resolve(workspaceDir);
        this.policy = policy;
    }

    private resolveCommandPath(bareName: string): { ok: true; absPath: string } | { ok: false; reason: string } {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bareName)) {
            return { ok: false, reason: `拒绝非裸命令名：${bareName}` };
        }
        const isWin = process.platform === 'win32';
        const candidates = isWin ? [`${bareName}.cmd`, `${bareName}.exe`] : [bareName];
        const pathDirs = (process.env.PATH || '')
            .split(isWin ? ';' : ':')
            .map(d => d.trim().replace(/^"|"$/g, ''))
            .filter(d => d.length > 0);
        for (const dir of pathDirs) {
            if (this.isInsideWorkspace(dir)) continue;
            for (const cand of candidates) {
                const full = path.join(dir, cand);
                try {
                    fsSync.accessSync(full, fsSync.constants.X_OK);
                    return { ok: true, absPath: path.resolve(full) };
                } catch { /* 继续搜索 */ }
            }
        }
        return { ok: false, reason: `PATH 上未找到命令“${bareName}”（工作区已从搜索范围排除）` };
    }

    private isInsideWorkspace(target: string): boolean {
        const resolved = path.resolve(target);
        const a = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        const b = process.platform === 'win32' ? this.workspaceDir.toLowerCase() : this.workspaceDir;
        return a === b || a.startsWith(b + path.sep);
    }

    private trimTail(s: string, max: number): string {
        if (s.length <= max) return s;
        let cut = s.slice(-max);
        const c = cut.charCodeAt(0);
        if (c >= 0xDC00 && c <= 0xDFFF) cut = cut.slice(1);
        return cut;
    }

    /** 宿主子进程的环境变量白名单（host 模式直接生效；docker CLI 进程共用同一白名单）。 */
    private buildChildEnv(): Record<string, string> {
        return {
            PATH: process.env.PATH || '',
            SYSTEMROOT: process.env.SYSTEMROOT || '',
            SYSTEMDRIVE: process.env.SYSTEMDRIVE || '',
            COMSPEC: process.env.COMSPEC || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
            TEMP: process.env.TEMP || process.env.TMP || '',
            TMP: process.env.TMP || process.env.TEMP || '',
            APPDATA: process.env.APPDATA || '',
            USERPROFILE: process.env.USERPROFILE || process.env.HOME || '',
            HOME: process.env.HOME || process.env.USERPROFILE || '',
            CARGO_HOME: process.env.CARGO_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo'),
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
            PYTHONIOENCODING: 'utf-8',
        };
    }

    private rejected(output: string): Promise<RunResult> {
        return Promise.resolve({ success: false, exitCode: null, output, timedOut: false, truncated: false });
    }

    /**
     * 执行入口：按解析好的执行策略分发。
     * `command` 永远由 sniffTestCommand 决定（写手不控制），白名单作为纵深防御保留。
     */
    public run(command: string, args: string[], timeoutMs: number = 60000): Promise<RunResult> {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            timeoutMs = 60000;
        }
        const cmdBase = command.replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
        if (!TEST_TOOL_WHITELIST.includes(cmdBase)) {
            return this.rejected(`[安全拦截] 运行机拒绝执行未授权命令：${command}`);
        }
        if (this.policy.kind === 'blocked') {
            return this.rejected(
                `[安全拦截] 测试未执行（沙箱不可用，fail-closed）：${this.policy.reason}\n`
                + '你选择了容器模式（sandbox.mode="auto"/"docker"），当前环境无法提供容器，运行机拒绝执行测试。\n'
                + '处理方式：安装/启动 Docker；或改用 sandbox.mode: "host"（宿主直执，无隔离）接受宿主执行。');
        }
        if (this.policy.kind === 'docker') {
            return this.runDocker(cmdBase, args, timeoutMs);
        }
        return this.runHost(cmdBase, args, timeoutMs);
    }

    /** 宿主直接执行（policy=host，无隔离）：保留全部历史防注入加固。 */
    private async runHost(cmdBase: string, args: string[], timeoutMs: number): Promise<RunResult> {
        const resolution = this.resolveCommandPath(cmdBase);
        if (!resolution.ok) {
            return this.rejected(`[安全拦截] ${resolution.reason}`);
        }
        const isWin = process.platform === 'win32';
        const useCmdShim = isWin && resolution.absPath.toLowerCase().endsWith('.cmd');
        if (useCmdShim && args.some(a => Runner.CMD_META.test(a))) {
            return this.rejected(`[安全拦截] 参数包含 cmd 元字符，拒绝执行：${args.join(' ')}`);
        }

        let file: string;
        let argv: string[];
        if (useCmdShim) {
            const cliParts = Runner.SHIM_CLI[cmdBase];
            const cliJs = cliParts ? path.join(path.dirname(resolution.absPath), ...cliParts) : null;
            const nodeRes = cliJs && fsSync.existsSync(cliJs) ? this.resolveCommandPath('node') : null;
            if (cliJs && nodeRes && nodeRes.ok) {
                file = nodeRes.absPath;
                argv = [cliJs, ...args];
            } else {
                // 找不到安全入口，直接拒绝执行，不做 cmd.exe 兜底。
                return this.rejected(`[安全拦截] 无法安全执行 ${cmdBase}：找不到底层的 JS 入口或 node 命令。为防工作区注入，已拒绝 cmd.exe 回退。`);
            }
        } else {
            file = resolution.absPath;
            argv = args;
        }
        return this.spawnAndCollect({
            file,
            args: argv,
            cwd: this.workspaceDir,
            env: this.buildChildEnv(),
            timeoutMs,
            detachGroup: process.platform !== 'win32',
        });
    }

    /** 一次性容器执行（policy=docker）：工作区复制进暂存目录挂载，容器内无网络、非 root、资源受限。 */
    private async runDocker(cmdBase: string, args: string[], timeoutMs: number): Promise<RunResult> {
        if (this.policy.kind !== 'docker') return this.rejected('[运行机错误] runDocker 在非 docker 策略下被调用');
        const image = this.policy.image.trim() || defaultImageForCommand(cmdBase);
        const dockerRes = resolveDockerExecutable(this.workspaceDir);
        if (!dockerRes.ok) {
            return this.rejected(`[安全拦截] Docker 不可用，测试未执行：${dockerRes.reason}`);
        }

        // 复制工作区到一次性暂存目录：容器写的是副本，宿主工作区本身不暴露给容器。
        const staging = path.join(os.tmpdir(), `dacw-sandbox-${crypto.randomBytes(8).toString('hex')}`);
        try {
            await fs.cp(this.workspaceDir, staging, {
                recursive: true,
                filter: (src: string) => {
                    const base = path.basename(src);
                    return base !== '.git' && base !== '.dacw-workspace';
                },
            });
        } catch (e: any) {
            await fs.rm(staging, { recursive: true, force: true }).catch(() => { });
            return this.rejected(`[安全拦截] 复制工作区到一次性暂存目录失败，测试未执行：${e?.message ?? String(e)}`);
        }

        const containerName = newContainerName();
        const argv = buildDockerRunArgv(
            { image, memoryMb: this.policy.memoryMb, cpus: this.policy.cpus, pidsLimit: this.policy.pidsLimit, tmpfsMb: this.policy.tmpfsMb },
            staging, containerName, cmdBase, args,
        );
        try {
            return await this.spawnAndCollect({
                file: dockerRes.absPath,
                args: argv,
                cwd: this.workspaceDir,
                env: this.buildChildEnv(),
                timeoutMs,
                detachGroup: false,
                extraKill: () => {
                    // 杀掉 docker CLI 不会杀容器（容器在守护进程侧）；rm -f 兜底强删。
                    try {
                        spawn(dockerRes.absPath, ['rm', '-f', containerName], {
                            stdio: 'ignore', windowsHide: true, shell: false,
                        }).unref?.();
                    } catch { /* 尽力而为 */ }
                },
            });
        } finally {
            await fs.rm(staging, { recursive: true, force: true }).catch(() => { });
        }
    }

    /** 共享的「spawn → 收集输出 → 超时强杀」机制；host 与 docker 两条路径共用。 */
    private spawnAndCollect(opts: SpawnCollectOptions): Promise<RunResult> {
        return new Promise<RunResult>((resolve) => {
            let child: ChildProcess;
            try {
                child = spawn(opts.file, opts.args, {
                    cwd: opts.cwd,
                    env: opts.env,
                    shell: false,
                    detached: opts.detachGroup,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (syncErr: any) {
                return resolve({
                    success: false, exitCode: null,
                    output: `[运行机错误] spawn 同步失败：${syncErr?.message}`,
                    timedOut: false, truncated: false
                });
            }

            const timeoutMs = opts.timeoutMs;
            let output = '';
            let truncated = false;
            let timedOut = false;
            let settled = false;
            let spawnError: Error | null = null;
            let exitCode: number | null = null;
            let exitSignal: NodeJS.Signals | null = null;

            let exitGraceTimer: NodeJS.Timeout | null = null;
            let killGraceTimer: NodeJS.Timeout | null = null;

            const stdoutDecoder = new StringDecoder('utf8');
            const stderrDecoder = new StringDecoder('utf8');
            let lineOpen = false;

            const appendLog = (data: Buffer, decoder: StringDecoder, tag: string) => {
                if (output.length >= this.HARD_LIMIT_CHARS) {
                    truncated = true;
                    return;
                }
                const text = decoder.write(data);
                if (text.length === 0) return;
                const lines = text.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (i > 0) {
                        output += '\n';
                        lineOpen = false;
                    }
                    const line = lines[i];
                    if (line.length === 0) continue;
                    if (!lineOpen) {
                        output += tag;
                        lineOpen = true;
                    }
                    output += line;
                }
                if (output.length > this.HARD_LIMIT_CHARS) {
                    output = this.trimTail(output, this.MAX_OUTPUT_CHARS);
                    truncated = true;
                }
            };

            child.stdout?.on('data', (d: Buffer) => appendLog(d, stdoutDecoder, '[out] '));
            child.stderr?.on('data', (d: Buffer) => appendLog(d, stderrDecoder, '[err] '));

            const killTree = () => {
                if (typeof child.pid !== 'number') return;
                if (process.platform === 'win32') {
                    const tk = spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
                    tk.on('error', () => { try { child.kill('SIGKILL'); } catch { } });
                } else if (opts.detachGroup) {
                    try { process.kill(-child.pid, 'SIGKILL'); }
                    catch { try { child.kill('SIGKILL'); } catch { } }
                } else {
                    try { child.kill('SIGKILL'); } catch { }
                }
                try { opts.extraKill?.(); } catch { /* 尽力而为 */ }
            };

            const finalize = () => {
                if (settled) return;
                settled = true;
                if (mainTimer) clearTimeout(mainTimer);
                if (exitGraceTimer) clearTimeout(exitGraceTimer);
                if (killGraceTimer) clearTimeout(killGraceTimer);

                if (spawnError) {
                    resolve({
                        success: false, exitCode: null,
                        output: `[运行机错误] ${spawnError.message}`,
                        timedOut: false, truncated: false
                    });
                    return;
                }

                let finalOutput = output;
                if (finalOutput.length > this.MAX_OUTPUT_CHARS) {
                    finalOutput = this.trimTail(finalOutput, this.MAX_OUTPUT_CHARS);
                }
                if (truncated) finalOutput = '...[输出超出上限，前部已丢弃]\n' + finalOutput;
                if (timedOut) {
                    finalOutput += `\n[执行超时 ${timeoutMs}ms，运行机已强杀进程树；exitCode=${exitCode ?? 'null'}, signal=${exitSignal ?? 'none'}]`;
                }
                resolve({
                    success: !timedOut && exitCode === 0,
                    exitCode,
                    output: finalOutput,
                    timedOut,
                    truncated
                });
            };

            const mainTimer = setTimeout(() => {
                timedOut = true;
                killTree();
                killGraceTimer = setTimeout(finalize, this.KILL_GRACE_MS);
            }, timeoutMs);

            child.on('exit', (code, signal) => {
                exitCode = code;
                exitSignal = signal;
                exitGraceTimer = setTimeout(finalize, this.EXIT_GRACE_MS);
            });

            child.on('close', (code) => {
                if (exitCode === null && code !== null) exitCode = code;
                finalize();
            });

            child.on('error', (err) => {
                if (typeof child.pid !== 'number' && !spawnError) {
                    spawnError = err;
                    finalize();
                }
            });
        });
    }
}
