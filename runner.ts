/**
 * ⚠️ 安全边界声明（极其重要）：
 * 本运行机（Runner）不是容器级沙盒。
 * 命令白名单仅用于防止命令注入（如防止写手传入 `npm rm -rf /`），
 * 但不具备隔离不受信任代码的能力。测试脚本（如 `npm test`）会执行写手生成的任意代码，
 * 这些代码拥有与当前 Node 进程相同的文件系统、网络和进程权限。
 * 如果写手模型不可信，必须将本运行机置于 Docker、虚拟机或 gVisor 等真正的沙盒中运行。
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fsSync from 'fs';
import { StringDecoder } from 'string_decoder';

export interface RunResult {
    success: boolean;
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    truncated: boolean;
}

export class Runner {
    private workspaceDir: string;
    private readonly MAX_OUTPUT_CHARS = 50_000;
    private readonly HARD_LIMIT_CHARS = 100_000;
    private readonly KILL_GRACE_MS = 2_000;
    private readonly EXIT_GRACE_MS = 1_500;
    private readonly ALLOWED_CMDS = ['npm', 'pnpm', 'yarn', 'npx', 'node', 'python', 'python3', 'pytest', 'cargo', 'go'];
    private static readonly CMD_META = /[&|<>^%!"\r\n]/;

    private static readonly SHIM_CLI: Record<string, string[]> = {
        npm: ['node_modules', 'npm', 'bin', 'npm-cli.js'],
        npx: ['node_modules', 'npm', 'bin', 'npx-cli.js'],
        pnpm: ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'],
        yarn: ['node_modules', 'yarn', 'bin', 'yarn.js'],
    };

    constructor(workspaceDir: string) {
        this.workspaceDir = path.resolve(workspaceDir);
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

    public run(command: string, args: string[], timeoutMs: number = 60000): Promise<RunResult> {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            timeoutMs = 60000;
        }
        const cmdBase = command.replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
        if (!this.ALLOWED_CMDS.includes(cmdBase)) {
            return Promise.resolve({
                success: false, exitCode: null,
                output: `[安全拦截] 运行机拒绝执行未授权命令：${command}`,
                timedOut: false, truncated: false
            });
        }

        const resolution = this.resolveCommandPath(cmdBase);
        if (!resolution.ok) {
            return Promise.resolve({
                success: false, exitCode: null,
                output: `[安全拦截] ${resolution.reason}`,
                timedOut: false, truncated: false
            });
        }

        const isWin = process.platform === 'win32';
        const useCmdShim = isWin && resolution.absPath.toLowerCase().endsWith('.cmd');
        if (useCmdShim && args.some(a => Runner.CMD_META.test(a))) {
            return Promise.resolve({
                success: false, exitCode: null,
                output: `[安全拦截] 参数包含 cmd 元字符，拒绝执行：${args.join(' ')}`,
                timedOut: false, truncated: false
            });
        }

        const childEnv = {
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

        return new Promise<RunResult>((resolve) => {
            let child: ChildProcess;
            try {
                if (useCmdShim) {
                    const cliParts = Runner.SHIM_CLI[cmdBase];
                    const cliJs = cliParts ? path.join(path.dirname(resolution.absPath), ...cliParts) : null;
                    const nodeRes = cliJs && fsSync.existsSync(cliJs) ? this.resolveCommandPath('node') : null;
                    
                    if (cliJs && nodeRes && nodeRes.ok) {
                        child = spawn(nodeRes.absPath, [cliJs, ...args], {
                            cwd: this.workspaceDir,
                            env: childEnv,
                            shell: false,
                            windowsHide: true,
                            stdio: ['ignore', 'pipe', 'pipe']
                        });
                    } else {
                        // 删除了 cmd.exe 兜底。找不到安全入口，直接拒绝执行。
                        return resolve({
                            success: false, exitCode: null,
                            output: `[安全拦截] 无法安全执行 ${cmdBase}：找不到底层的 JS 入口或 node 命令。为防工作区注入，已拒绝 cmd.exe 回退。`,
                            timedOut: false, truncated: false
                        });
                    }
                } else {
                    child = spawn(resolution.absPath, args, {
                        cwd: this.workspaceDir,
                        env: childEnv,
                        shell: false,
                        detached: process.platform !== 'win32',
                        windowsHide: true,
                        stdio: ['ignore', 'pipe', 'pipe']
                    });
                }
            } catch (syncErr: any) {
                return resolve({
                    success: false, exitCode: null,
                    output: `[运行机错误] spawn 同步失败：${syncErr?.message}`,
                    timedOut: false, truncated: false
                });
            }

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
                } else {
                    try { process.kill(-child.pid, 'SIGKILL'); }
                    catch { try { child.kill('SIGKILL'); } catch { } }
                }
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