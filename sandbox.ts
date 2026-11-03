/**
 * 沙箱策略层——决定「写手产出的测试代码」在哪里执行。
 *
 * [为什么需要这一层] DACW 的执行顺序是「写手落盘 → 运行机测试 → 审查者审计」：
 * 测试在任何审查之前执行，审查（无论模型还是人工）看到的都是已经执行过的代码，
 * 因此审查是【侦探性控制】，绝不是执行前的安全屏障。子代理工具隔离只约束子代理
 * 能否调用宿主工具，同样不能约束测试进程本身。唯一有效的预防性控制是隔离执行：
 *
 *   - mode 'host'（默认，主线）：执行隔离默认关闭——测试以宿主用户全权限运行写手产出的
 *     任意代码（命令白名单只防命令注入，不构成隔离）。
 *   - mode 'auto'（显式配置才生效）：Docker 可用 → 一次性容器执行（见下）；不可用时
 *     不崩溃、不静默降级，而是弹出「是否关闭沙盒」的人类确认（consent 流程）：
 *     用户确认关闭才改为宿主直执并标注安全降级；选择保持或无法确认则 fail-closed 停止。
 *   - mode 'docker'（显式配置）：强制一次性容器执行（无网络、只读根文件系统、非 root/uid 1000、
 *     cap-drop ALL、no-new-privileges、内存/CPU/进程数上限；工作区复制到一次性暂存目录
 *     再挂载，宿主工作区本身不进入容器）；Docker 不可用时拒绝运行（不询问、不降级）。
 *
 * [分叉点] temp-sandbox 线默认 auto + 交互同意；mvp-1 线默认 host。合并时注意默认值冲突。
 *
 * [边界] Docker 容器不是完美隔离：它共享宿主内核，镜像本身必须可信（仅使用
 * 官方镜像或经过审查的镜像），Docker Desktop 的文件共享层也有自身攻击面。
 * mode 'host' 下运行机（runner.ts）的命令白名单只防命令注入，不构成隔离。
 */
import { spawn } from 'child_process';
import * as path from 'path';
import * as fsSync from 'fs';
import * as crypto from 'crypto';

/** 测试命令白名单：写手不控制测试命令（由 sniffTestCommand 决定），此表仍作为纵深防御保留。 */
export const TEST_TOOL_WHITELIST = ['npm', 'pnpm', 'yarn', 'npx', 'node', 'python', 'python3', 'pytest', 'cargo', 'go'];

export const SANDBOX_MODES = ['auto', 'docker', 'host'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export interface SandboxConfig {
    /**
     * host（默认，主线）：执行隔离默认关闭，测试在宿主用户权限下运行；
     * auto（显式配置）：Docker 可用则容器化，不可用时交互询问是否降级；
     * docker（显式配置）：强制容器，不可用时拒绝运行（不询问、不降级）。
     */
    mode: SandboxMode;
    /** 容器镜像；空串表示按测试命令自动选择官方镜像。 */
    image: string;
    memoryMb: number;
    /** 允许小数（--cpus 1.5）。 */
    cpus: number;
    pidsLimit: number;
    /** 容器内 /tmp 的大小上限（MB）。 */
    tmpfsMb: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
    mode: 'host',
    image: '',
    memoryMb: 1024,
    cpus: 1,
    pidsLimit: 256,
    tmpfsMb: 128,
};

/** 测试执行策略（每次 dacw_run 调用解析一次）。 */
export type ExecutionPolicy =
    | { kind: 'host' }
    | { kind: 'docker'; image: string; memoryMb: number; cpus: number; pidsLimit: number; tmpfsMb: number }
    | { kind: 'blocked'; reason: string; mode: SandboxMode };

/** 沙盒不可用时的确认选项（model/UI 中展示）。 */
export interface SandboxConsentOption {
    id: 'keep_sandbox' | 'disable_sandbox';
    label: string;
    description: string;
}

/** 交给宿主交互 seam（ctx.userQuestions）的确认请求。 */
export interface SandboxConsentRequest {
    title: string;
    message: string;
    detail: string;
    options: SandboxConsentOption[];
}

/** 用户对「是否关闭沙盒」的回答；unavailable 表示无法取得人类回答（fail-closed）。 */
export type SandboxConsentResult =
    | { decision: 'keep_sandbox' }
    | { decision: 'disable_sandbox' }
    | { decision: 'unavailable'; reason: string };

/**
 * 构造「沙盒不可用 → 是否关闭沙盒」的确认请求。警告文案固定为产品口径，
 * `detail` 携带实际检测结果（以检测内容输出）。
 */
export function buildSandboxConsentRequest(plan: Extract<ExecutionPolicy, { kind: 'blocked' }>): SandboxConsentRequest {
    return {
        title: '沙盒不可用',
        message: '未检测到可用的沙盒隔离环境（如 Docker 未安装或未启动）。是否关闭沙盒模式并继续？',
        detail: `检测结果（sandbox.mode="${plan.mode}"）：${plan.reason}`,
        options: [
            {
                id: 'keep_sandbox',
                label: '保持沙盒（取消本次运行）',
                description: '不会在宿主上执行任何测试代码；安装/启动 Docker 后可重试。',
            },
            {
                id: 'disable_sandbox',
                label: '关闭沙盒并继续',
                description: '本次运行的测试将以宿主用户全权限执行，AI 生成的代码会直接接触宿主系统（安全降级，结果会标注）。',
            },
        ],
    };
}

/**
 * 解析人类回答（宿主 ask() 返回值：{ answers: [{ id, selected: string[] }] }）。
 * 只认本次请求的选项 label；未选中/无回答/未知答案一律视为 keep_sandbox（fail-closed）。
 */
export function parseSandboxConsentAnswer(
    answer: unknown,
    request: SandboxConsentRequest,
    questionId = 'dacw-sandbox-consent',
): SandboxConsentResult {
    if (!answer || typeof answer !== 'object') return { decision: 'keep_sandbox' };
    const answers = (answer as any).answers;
    if (!Array.isArray(answers)) return { decision: 'keep_sandbox' };
    const hit = answers.find((item: any) => item && item.id === questionId);
    if (!hit || !Array.isArray(hit.selected)) return { decision: 'keep_sandbox' };
    const selectedLabels: string[] = hit.selected.filter((label: unknown): label is string => typeof label === 'string');
    const disableOption = request.options.find((option) => option.id === 'disable_sandbox');
    const keepOption = request.options.find((option) => option.id === 'keep_sandbox');
    if (disableOption && selectedLabels.includes(disableOption.label)) return { decision: 'disable_sandbox' };
    if (keepOption && selectedLabels.includes(keepOption.label)) return { decision: 'keep_sandbox' };
    return { decision: 'keep_sandbox' };
}

function pushWarning(warnings: string[], prefix: string, message: string): void {
    warnings.push(prefix ? `${prefix}.${message}` : message);
}

function positiveIntOr(value: unknown, fallback: number, warnings: string[], prefix: string, field: string): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
    pushWarning(warnings, prefix, `${field} 非法（需要正数），已回退默认值 ${fallback}`);
    return fallback;
}

function positiveNumberOr(value: unknown, fallback: number, warnings: string[], prefix: string, field: string): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    pushWarning(warnings, prefix, `${field} 非法（需要正数），已回退默认值 ${fallback}`);
    return fallback;
}

/**
 * 归一化沙箱配置；非法字段回退默认值并记录警告（不抛错）。
 * `prefix` 用于插件配置面（如 'config.sandbox'），引擎直连时传 ''。
 * 纯函数，供回归自测。
 */
export function normalizeSandboxConfig(raw: unknown, warnings: string[], prefix: string): SandboxConfig {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    let mode = input.mode;
    if (mode === undefined || mode === null) mode = DEFAULT_SANDBOX_CONFIG.mode;
    if (typeof mode !== 'string' || !(SANDBOX_MODES as readonly string[]).includes(mode)) {
        pushWarning(warnings, prefix, `mode 非法（只接受 ${SANDBOX_MODES.join(' / ')}），已回退 "${DEFAULT_SANDBOX_CONFIG.mode}"`);
        mode = DEFAULT_SANDBOX_CONFIG.mode;
    }
    let image = input.image;
    if (image === undefined || image === null) image = DEFAULT_SANDBOX_CONFIG.image;
    if (typeof image !== 'string') {
        pushWarning(warnings, prefix, 'image 非法（需要字符串），已回退默认值（按测试命令自动选择镜像）');
        image = DEFAULT_SANDBOX_CONFIG.image;
    }
    return {
        mode: mode as SandboxMode,
        image: image.trim(),
        memoryMb: positiveIntOr(input.memoryMb, DEFAULT_SANDBOX_CONFIG.memoryMb, warnings, prefix, 'memoryMb'),
        cpus: positiveNumberOr(input.cpus, DEFAULT_SANDBOX_CONFIG.cpus, warnings, prefix, 'cpus'),
        pidsLimit: positiveIntOr(input.pidsLimit, DEFAULT_SANDBOX_CONFIG.pidsLimit, warnings, prefix, 'pidsLimit'),
        tmpfsMb: positiveIntOr(input.tmpfsMb, DEFAULT_SANDBOX_CONFIG.tmpfsMb, warnings, prefix, 'tmpfsMb'),
    };
}

/** 按测试命令选择默认官方镜像（仅当 config.sandbox.image 为空时）。 */
export function defaultImageForCommand(command: string): string {
    switch (command) {
        case 'python':
        case 'python3':
        case 'pytest':
            return 'python:3.12-slim';
        case 'cargo':
            return 'rust:1-slim';
        case 'go':
            return 'golang:1.23-bookworm';
        default:
            return 'node:22-bookworm-slim';
    }
}

/**
 * 构造 `docker run` 参数（纯函数，供回归自测）。
 *
 * 安全语义：
 *   - `--network none`：容器内无网络；
 *   - `--read-only` + `--tmpfs /tmp:rw,nosuid,size=…m`：根文件系统只读，仅 /tmp 可写；
 *   - `--user 1000:1000`：非 root（node 官方镜像自带 uid 1000 的 node 用户；
 *     其他镜像接受任意数字 uid）+ `-e HOME=/tmp` 保证缓存目录可写；
 *   - `--cap-drop ALL` + `--security-opt no-new-privileges`：最小能力集；
 *   - `--memory/--memory-swap/--cpus/--pids-limit`：资源上限（memory-swap=memory 禁 swap）;
 *   - `--rm` + 随机容器名：一次性容器，超时后可 `docker rm -f` 兜底强杀；
 *   - 工作区被复制到 `stagingDir` 后挂载为 /dacw，宿主工作区本身不进入容器。
 */
export function buildDockerRunArgv(
    policy: { image: string; memoryMb: number; cpus: number; pidsLimit: number; tmpfsMb: number },
    stagingDir: string,
    containerName: string,
    command: string,
    args: string[],
): string[] {
    return [
        'run',
        '--rm',
        '--pull=missing',
        '--name', containerName,
        '--network', 'none',
        '--memory', `${policy.memoryMb}m`,
        '--memory-swap', `${policy.memoryMb}m`,
        '--cpus', String(policy.cpus),
        '--pids-limit', String(policy.pidsLimit),
        '--read-only',
        '--tmpfs', `/tmp:rw,nosuid,size=${policy.tmpfsMb}m`,
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--user', '1000:1000',
        '-e', 'HOME=/tmp',
        '-e', 'CI=1',
        '-e', 'npm_config_update_notifier=false',
        '--volume', `${stagingDir}:/dacw`,
        '--workdir', '/dacw',
        '--init',
        policy.image,
        command,
        ...args,
    ];
}

/** 供日志/结果消息使用的一行策略描述。 */
export function describePolicy(policy: ExecutionPolicy): string {
    if (policy.kind === 'docker') {
        return `一次性 Docker 容器（image=${policy.image || '按测试命令自动选择'}；无网络、只读根文件系统、非 root、`
            + `cap-drop ALL、内存 ${policy.memoryMb}MB、CPU ${policy.cpus}、进程数上限 ${policy.pidsLimit}）`;
    }
    if (policy.kind === 'host') {
        return '宿主直接执行（无隔离）：写手产出的代码将以宿主用户全权限运行';
    }
    return `已拒绝执行测试（fail-closed）：${policy.reason}`;
}

/** 在宿主 PATH 上解析 docker 可执行文件；`excludeDir`（通常是 DACW 工作区）从搜索范围排除。 */
export function resolveDockerExecutable(excludeDir?: string): { ok: true; absPath: string } | { ok: false; reason: string } {
    const isWin = process.platform === 'win32';
    const candidates = isWin ? ['docker.exe'] : ['docker'];
    const pathDirs = (process.env.PATH || '')
        .split(isWin ? ';' : ':')
        .map((d) => d.trim().replace(/^"|"$/g, ''))
        .filter((d) => d.length > 0);
    const excluded = path.resolve(excludeDir && excludeDir.trim() ? excludeDir : process.cwd());
    const excludedLower = isWin ? excluded.toLowerCase() : excluded;
    for (const dir of pathDirs) {
        const resolved = path.resolve(dir);
        const resolvedLower = isWin ? resolved.toLowerCase() : resolved;
        if (resolvedLower === excludedLower || resolvedLower.startsWith(excludedLower + path.sep)) continue;
        for (const cand of candidates) {
            const full = path.join(resolved, cand);
            try {
                fsSync.accessSync(full, fsSync.constants.X_OK);
                return { ok: true, absPath: path.resolve(full) };
            } catch { /* 继续搜索 */ }
        }
    }
    return { ok: false, reason: 'PATH 上未找到 docker 可执行文件（工作区目录已从搜索范围排除）' };
}

/** 探测 Docker CLI + 守护进程是否可用（`docker version` 会 ping 守护进程）。 */
export function detectDocker(timeoutMs = 4000): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
    const resolution = resolveDockerExecutable();
    if (!resolution.ok) return Promise.resolve({ ok: false, reason: resolution.reason });
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(resolution.absPath, ['version', '--format', '{{.Server.Version}}'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                shell: false,
            });
        } catch (e: any) {
            resolve({ ok: false, reason: `docker 探测进程启动失败：${e?.message ?? String(e)}` });
            return;
        }
        let output = '';
        let settled = false;
        const done = (result: { ok: true; version: string } | { ok: false; reason: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill(); } catch { /* 已退出 */ }
            resolve(result);
        };
        const timer = setTimeout(() => {
            done({ ok: false, reason: 'docker version 探测超时（守护进程无响应？）' });
        }, timeoutMs);
        child.stdout?.on('data', (d: Buffer) => { output += d.toString('utf8'); });
        child.stderr?.on('data', () => { /* 版本不可用时的细节不参与判定 */ });
        child.on('error', (err) => done({ ok: false, reason: `docker 探测失败：${err.message}` }));
        child.on('close', (code) => {
            const version = output.trim();
            if (code === 0 && version) done({ ok: true, version });
            else done({ ok: false, reason: `docker version 退出码 ${code ?? 'null'}（Docker 未安装或守护进程未启动）` });
        });
    });
}

/**
 * 解析本次调用的执行策略：
 *   - host（默认）→ 直接宿主执行（执行隔离默认关闭；用户已接受无隔离风险）；
 *   - auto → Docker 可用则容器化；不可用返回 blocked——由调用方发起「是否关闭沙盒」的人类确认，
 *     拒绝或无法确认则 fail-closed 停止；
 *   - docker → Docker 不可用返回 blocked（调用方直接拒绝运行，不询问、不降级）。
 * `detect` 可注入（回归测试 / 宿主自定义探测），默认 detectDocker。
 */
export async function resolveExecutionPolicy(
    config: SandboxConfig,
    detect: () => Promise<{ ok: true; version: string } | { ok: false; reason: string }> = detectDocker,
): Promise<ExecutionPolicy> {
    if (config.mode === 'host') return { kind: 'host' };
    const detection = await detect();
    if (detection.ok) {
        return { kind: 'docker', image: config.image, memoryMb: config.memoryMb, cpus: config.cpus, pidsLimit: config.pidsLimit, tmpfsMb: config.tmpfsMb };
    }
    return { kind: 'blocked', reason: detection.reason, mode: config.mode };
}

/** 生成一次性容器名（随机，防并发冲突；超时兜底 `docker rm -f` 用）。 */
export function newContainerName(): string {
    return `dacw-${crypto.randomBytes(6).toString('hex')}`;
}
