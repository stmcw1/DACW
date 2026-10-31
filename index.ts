/**
 * DACW 协调器（Coordinator）—— 「写手 → 运行机 → 审查者 → 人工闸门」的确定性状态机。
 *
 * 本文件只依赖注入进来的 `DSHContext`（chat / log），不直接依赖任何宿主 API：
 *   - 独立运行 / 回归自测：见 selftest.mjs 与 demo.ts（注入 mock context）；
 *   - DSH Host 插件：见 plugin.ts（把 `chat` 接到 `ctx.subagents` 的子代理上，
 *     把 `log` 接到宿主日志，并注册 `dacw_run` 工具）。
 *
 * 安全不变量（改动前请先读 SAFETY.md）：
 *   1. 工作区内容恒等于「基线合并集」，任何时候都不先清空再等待；
 *   2. changed / deleted 均做词法越权校验；地基文件与高危目录禁止删除；
 *   3. 所有终止路径收敛到 NEED_HUMAN，绝不自动合入；
 *   4. 裁决必须为精确 JSON，解析失败一律按 REJECTED 处理；
 *   5. 测试在任何审查之前执行——审查是侦探性控制不是预防性控制，因此测试的
 *      执行位置由 sandbox 策略层决定：默认宿主直执（无隔离），容器模式为可选配置
 *      （见 sandbox.ts）；
 *   6. 审查对象 === 最终交付物：测试通过后必须重新枚举工作区与基线对账，任何无法
 *      解释的新增/删除/内容变更一律转人工（success:false），审查输入只来自对账后的
 *      最终清单。
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import { Runner } from './runner';
import { StateManager } from './state_manager';
import { DEFAULT_SANDBOX_CONFIG, buildSandboxConsentRequest, describePolicy, detectDocker, normalizeSandboxConfig, resolveExecutionPolicy } from './sandbox';
import type { ExecutionPolicy, SandboxConfig, SandboxConsentRequest, SandboxConsentResult } from './sandbox';

/**
 * 协调器对宿主的最小依赖面。
 *
 * `chat(agentId, prompt, context)` 拒绝（reject）时：
 *   - 超时错误必须带 `isChatTimeout === true`（安全重试策略依赖该结构化标记）；
 *   - 取消错误必须带 `isAbort === true` 或 `name === 'AbortError'`（不重试，立即终止）。
 */
export interface DSHContext {
    chat: (agentId: string, prompt: string, context: string) => Promise<string>;
    log: (msg: string) => void;
    /**
     * 可选的人类交互能力（插件侧接 ctx.userQuestions）：沙盒不可用时用于弹出
     * 「是否关闭沙盒」确认。缺失时引擎 fail-closed 停止（绝不静默降级到宿主执行）。
     */
    askUserQuestion?: (request: SandboxConsentRequest) => Promise<SandboxConsentResult>;
}

/** Docker 探测结果 / 探测器（可注入，供回归测试或宿主自定义探测）。 */
export type SandboxDetection = { ok: true; version: string } | { ok: false; reason: string };
export type SandboxDetector = () => Promise<SandboxDetection>;

/** 可调参数；全部通过 `apply(context, options)` 注入，便于宿主配置与回归自测。 */
export interface EngineOptions {
    maxRounds: number;
    chatTimeoutBaseMs: number;
    chatTimeoutPer10kCharsMs: number;
    chatTimeoutMaxMs: number;
    chatMaxAttempts: number;
    writerOutputMaxChars: number;
    manifestMaxEntries: number;
    /** 审查阶段送入审查者的最大字符数（超出截断并标记）。 */
    reviewInputMaxChars: number;
    /** 审查阶段单个文件的最大字符数（超出按头截断并标记）。 */
    reviewFileMaxChars: number;
    /** 已解析的写手/审查者模型标签（含来源），用于启动日志展示；null 表示宿主未提供。 */
    roleModels: { writer: string; reviewer: string } | null;
    /** 状态文件目录；null 表示 `os.tmpdir()/dacw-state`。 */
    stateDir: string | null;
    /** 测试执行策略：默认 host（宿主直执，无隔离）；容器模式为可选配置（sandbox 分支）。 */
    sandbox: SandboxConfig;
    /** 用户是否显式配置了 sandbox.mode="host"（用于日志分级：显式 → 红色警告；默认值 → 普通提示）。 */
    sandboxExplicit: boolean;
    /**
     * G3 逃生门（默认关）：允许"审查不完整"（输入被截断 / 锁文件仅送摘要）时仍放行 success:true。
     * 打开即降低安全保证：只有显式配置才生效，且 message/日志/files 会持续标注。
     */
    allowTruncatedReview: boolean;
    /** 沙盒探测函数（回归测试 / 宿主自定义）；null 表示使用内置 detectDocker。 */
    sandboxDetect: SandboxDetector | null;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
    maxRounds: 3,
    chatTimeoutBaseMs: 120_000,
    chatTimeoutPer10kCharsMs: 20_000,
    chatTimeoutMaxMs: 300_000,
    chatMaxAttempts: 2,
    writerOutputMaxChars: 2_000_000,
    manifestMaxEntries: 400,
    reviewInputMaxChars: 400_000,
    reviewFileMaxChars: 200_000,
    roleModels: null,
    stateDir: null,
    sandbox: DEFAULT_SANDBOX_CONFIG,
    sandboxExplicit: false,
    allowTruncatedReview: false,
    sandboxDetect: null,
};

function positiveInt(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 合并宿主传入的部分配置；非法值回退默认值（由调用方决定是否告警）。 */
export function resolveEngineOptions(partial?: Partial<EngineOptions> | null): EngineOptions {
    if (!partial || typeof partial !== 'object') return { ...DEFAULT_ENGINE_OPTIONS };
    const stateDir = partial.stateDir;
    const rawRoleModels = partial.roleModels;
    const roleModels = rawRoleModels && typeof rawRoleModels === 'object'
        && typeof (rawRoleModels as any).writer === 'string'
        && typeof (rawRoleModels as any).reviewer === 'string'
        ? { writer: (rawRoleModels as any).writer, reviewer: (rawRoleModels as any).reviewer }
        : null;
    return {
        maxRounds: positiveInt(partial.maxRounds, DEFAULT_ENGINE_OPTIONS.maxRounds),
        chatTimeoutBaseMs: positiveInt(partial.chatTimeoutBaseMs, DEFAULT_ENGINE_OPTIONS.chatTimeoutBaseMs),
        chatTimeoutPer10kCharsMs: positiveInt(partial.chatTimeoutPer10kCharsMs, DEFAULT_ENGINE_OPTIONS.chatTimeoutPer10kCharsMs),
        chatTimeoutMaxMs: positiveInt(partial.chatTimeoutMaxMs, DEFAULT_ENGINE_OPTIONS.chatTimeoutMaxMs),
        chatMaxAttempts: positiveInt(partial.chatMaxAttempts, DEFAULT_ENGINE_OPTIONS.chatMaxAttempts),
        writerOutputMaxChars: positiveInt(partial.writerOutputMaxChars, DEFAULT_ENGINE_OPTIONS.writerOutputMaxChars),
        manifestMaxEntries: positiveInt(partial.manifestMaxEntries, DEFAULT_ENGINE_OPTIONS.manifestMaxEntries),
        reviewInputMaxChars: positiveInt(partial.reviewInputMaxChars, DEFAULT_ENGINE_OPTIONS.reviewInputMaxChars),
        reviewFileMaxChars: positiveInt(partial.reviewFileMaxChars, DEFAULT_ENGINE_OPTIONS.reviewFileMaxChars),
        roleModels,
        stateDir: typeof stateDir === 'string' && stateDir.trim() !== '' ? stateDir : null,
        sandbox: normalizeSandboxConfig(partial.sandbox, [], 'sandbox'),
        sandboxExplicit: partial.sandboxExplicit === true,
        allowTruncatedReview: partial.allowTruncatedReview === true,
        sandboxDetect: typeof partial.sandboxDetect === 'function' ? partial.sandboxDetect : null,
    };
}

const FOUNDATION_REVIEW_FILES = ['package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod', 'tsconfig.json'];
const LOCK_REVIEW_DIGEST_FILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock'];
/** 锁文件审查策略：只送 SHA256 摘要，不送全文（与下方摘要循环保持一致）。 */
const LOCK_REVIEW_DIGEST_SET = new Set(LOCK_REVIEW_DIGEST_FILES);

/**
 * 敏感文件默认不送模型审查（内容不进入审查输入）；文件仍正常交付、仍在 `files` 清单中。
 * 排除项记入 `reviewExcluded`，供 F3 断言（iteratedKeys ∪ reviewExcluded === postDigest）与 message 标注。
 * 这是内容外发边界：秘密/AKey 不发给模型提供方，由人工在合入前审阅这些文件。
 */
const SENSITIVE_REVIEW_PATTERNS = [
    /^\.env$/i,
    /^\.env\..+$/i,
    /\.pem$/i,
    /\.key$/i,
    /\.p12$/i,
    /\.pfx$/i,
    /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
    /^\.npmrc$/i,
    /^\.netrc$/i,
    /^credentials(\..+)?$/i,
    /^secrets?(\..+)?$/i,
];

/** 审查阶段是否应排除该文件（按文件名判定；子目录同样生效）。纯函数，供回归自测。 */
export function isSensitiveReviewFile(relPath: string): boolean {
    const base = String(relPath).split(/[\\/]/).pop() || '';
    return SENSITIVE_REVIEW_PATTERNS.some((re) => re.test(base));
}

// [共享] 清理白名单（地基保护）：safeCleanWorkspace 保留 / mergeDelta 删除拦截 共用一份清单
// `.dacw-workspace` 是 DACW 自己的目录标记，随工作区一起保留，不参与基线合并。
const CLEAN_PROTECTED_PATTERNS = [
    /^package\.json$/, /^package-lock\.json$/, /^tsconfig\.json$/, /^node_modules$/,
    /^requirements\.txt$/, /^Cargo\.toml$/, /^go\.mod$/, /^\.git$/,
    /^pnpm-lock\.yaml$/, /^yarn\.lock$/, /^pyproject\.toml$/, /^poetry\.lock$/, /^setup\.py$/,
    /^Cargo\.lock$/, /^go\.sum$/, /^\.dacw-workspace$/
];
function isFoundationName(name: string): boolean {
    return CLEAN_PROTECTED_PATTERNS.some(p => p.test(name));
}

/** 词法越权校验（不触 fs）：mergeDelta 与写手路径校验共用，防 `../` 逃逸 */
function resolveInsideWorkspace(workspaceDir: string, relPath: string): string {
    const safeDir = path.resolve(workspaceDir);
    const target = path.resolve(safeDir, relPath);
    if (!target.startsWith(safeDir + path.sep) && target !== safeDir) {
        throw new Error(`[安全拦截] 试图越权写入工作区外部：${relPath}`);
    }
    return target;
}

/** 高危目录成员判定（写禁 + 删禁共用）：路径任一分段命中即拒 */
function touchesRiskyDir(relPath: string): boolean {
    const parts = relPath.split(/[\\/]/);
    return parts.includes('.git') || parts.includes('node_modules');
}

/**
 * [协议 v2] 增量合并：legacyFull=以输出替换整个基线（未提及的基线文件删除）；
 * delta=基线合并（未提及的保留）。changed 与 deleted 均做越权拦截；受保护地基文件与
 * 高危目录（.git / node_modules）禁止删除。仅做词法校验，不触 fs。
 */
export function mergeDelta(base: Map<string, string>, delta: WriterDelta, workspaceDir: string): Map<string, string> {
    const nextBase = delta.legacyFull ? new Map<string, string>() : new Map(base);
    for (const d of delta.deleted) {
        resolveInsideWorkspace(workspaceDir, d);
        if (isFoundationName(path.basename(d)) || touchesRiskyDir(d)) {
            throw new Error(`[安全拦截] 写手试图删除受保护的地基文件或目录：${d}`);
        }
        nextBase.delete(d);
    }
    for (const item of delta.changed) {
        resolveInsideWorkspace(workspaceDir, item.file);
        nextBase.set(item.file, item.code);
    }
    if (nextBase.size === 0) throw new Error('合并后文件集为空（changed/deleted 相互抵消或全为空）');
    return nextBase;
}

// ================= 会话操作策略 =================
/**
 * DSH 宿主存在会话分叉能力（AGENT_METHODS.session_fork / "session/fork"，
 * unstable_forkSession，experimental，需 agent 声明 session.fork capability），
 * 但当前插件 context.chat(agentId, prompt, context) 三参签名【未暴露 fork】。
 *
 * 设计红线（不可妥协）：失败反馈必须走显式 prompt（本文件 feedback 机制）；
 * 分叉只能丢"噪音"（残缺 JSON），绝不能丢"教训"（测试日志、REJECTED 原因）。
 * 宿主向插件暴露稳定 fork API 后实现本接口并在失败路径接入；当前 no-op，
 * DSH 适配层（plugin.ts）通过独立的子代理会话承担等价的"干净上下文"职责。
 */
interface ConversationOps {
    checkpoint(): void;
    discardSinceCheckpoint(): Promise<void>;
}
const NOOP_CONVERSATION: ConversationOps = {
    checkpoint(): void { },
    async discardSinceCheckpoint(): Promise<void> { },
};

// ================= 日志美化模块 =================
function getTimeStr(): string {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}
function logProgress(context: DSHContext, round: number, maxRounds: number, startTime: number, phase: string) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    context.log(`🎯 轮次 [${round}/${maxRounds}] | ⏳ 耗时: ${elapsed}s | ⚙️ 当前阶段: ${phase}`);
}
function logSystem(context: DSHContext, msg: string) { context.log(`[${getTimeStr()}] [System] ${msg}`); }
function logSuccess(context: DSHContext, msg: string) { context.log(`✅ ${msg}`); }
function logError(context: DSHContext, msg: string) { context.log(`❌ ${msg}`); }

/** 日志美化：显示本次运行实际生效的写手/审查者模型配置（来源由 plugin.ts 解析）。 */
function logModelConfig(context: DSHContext, roleModels: { writer: string; reviewer: string } | null) {
    if (!roleModels) return;
    context.log(`🧠 模型配置 | ✍️ 写手: ${roleModels.writer} | 🔍 审查者: ${roleModels.reviewer}`);
}

function isAbortError(e: unknown): boolean {
    if (e === null || typeof e !== 'object') return false;
    const anyE = e as Record<string, unknown>;
    return anyE.isAbort === true || anyE.name === 'AbortError';
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error(label);
            (err as any).isChatTimeout = true;   // 结构化超时标记：下游按类型判断，不做字符串匹配
            reject(err);
        }, ms);
        p.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}

type ChatOutcome = { ok: true; text: string } | { ok: false; reason: string; aborted?: boolean };

async function safeChat(context: DSHContext, agentId: string, prompt: string, contextStr: string, timeoutMs: number, maxAttempts: number): Promise<ChatOutcome> {
    let lastReason = '未知错误';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const text = await withTimeout(context.chat(agentId, prompt, contextStr), timeoutMs, `${agentId} 响应超时(${timeoutMs}ms)`);
            return { ok: true, text };
        } catch (e: any) {
            lastReason = e?.message || '未知错误';
            // 取消（用户中断 / 会话关闭）绝不重试：立即终止整个工作流。
            if (isAbortError(e)) {
                logError(context, `[取消] ${agentId} 调用被取消，工作流终止。`);
                return { ok: false, reason: lastReason, aborted: true };
            }
            // [修复] 超时绝不立即并发重试：会话中仍挂着未完成的请求，立即重试会造成
            // 并发与上下文错乱。按结构化标记判断（不再依赖错误文案字符串匹配）。
            if (e?.isChatTimeout === true) {
                logError(context, `[警告] ${agentId} 响应超时，为了防止并发导致上下文错乱，放弃本次重试。`);
                break;
            }
            if (attempt < maxAttempts) {
                logError(context, `[警告] ${agentId} 调用失败(${lastReason})，重试 ${attempt}/${maxAttempts - 1}...`);
            }
        }
    }
    return { ok: false, reason: lastReason };
}

/**
 * 逐段检查（工作区真实根 → 目标）已存在的路径祖先：任一段是符号链接或非目录即拒绝。
 * 必须在 mkdir 之前调用——否则 mkdir 会顺着链接在工作区外创建目录。
 */
async function assertNoSymlinkAncestors(realRoot: string, targetPath: string): Promise<void> {
    const relative = path.relative(realRoot, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`[安全拦截] 目标路径越过工作区真实根：${targetPath}`);
    }
    const segments = relative.split(path.sep).filter(Boolean);
    let current = realRoot;
    for (let i = 0; i < segments.length - 1; i += 1) {
        current = path.join(current, segments[i]);
        let stat: any;
        try {
            stat = await fs.lstat(current);
        } catch (e: any) {
            if (e.code === 'ENOENT') return;   // 其余段尚不存在，mkdir 会新建普通目录
            throw e;
        }
        if (stat.isSymbolicLink()) {
            throw new Error(`[安全拦截] 工作区路径包含符号链接：${path.relative(realRoot, current)}`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`[安全拦截] 工作区路径包含非目录项：${path.relative(realRoot, current)}`);
        }
    }
}

/** 把工作区内的相对路径解析为经过符号链接校验的真实目标路径（读、写共用）。 */
async function resolveInsideWorkspaceReal(workspaceDir: string, relPath: string): Promise<{ root: string; target: string }> {
    const safeDir = path.resolve(workspaceDir);
    const lexicalTarget = path.resolve(safeDir, relPath);
    if (!lexicalTarget.startsWith(safeDir + path.sep) && lexicalTarget !== safeDir) {
        throw new Error(`[安全拦截] 试图越权访问工作区外部：${relPath}`);
    }
    const root = await fs.realpath(safeDir);
    const target = path.resolve(root, path.relative(safeDir, lexicalTarget));
    await assertNoSymlinkAncestors(root, target);
    return { root, target };
}

// [漏洞3修复] 彻底使用真实路径 (realpath) 并进行 lstat 校验，防符号链接越权
async function safeWriteFile(workspaceDir: string, relativeFilePath: string, content: string) {
    // 1. 词法校验（防 `../`）+ 高危目录拦截
    if (touchesRiskyDir(relativeFilePath)) {
        throw new Error(`[安全拦截] 禁止修改受保护目录（.git / node_modules）：${relativeFilePath}`);
    }

    // 2. 真实路径 + 逐段符号链接校验（必须在 mkdir 之前）
    const { root, target: targetPath } = await resolveInsideWorkspaceReal(workspaceDir, relativeFilePath);

    // 3. 确保父目录存在
    const parentDir = path.dirname(targetPath);
    await fs.mkdir(parentDir, { recursive: true });

    // 4. lstat 检查：目标是否已存在且是个符号链接
    try {
        const stat = await fs.lstat(targetPath);
        if (stat.isSymbolicLink()) {
            throw new Error(`[安全拦截] 目标文件本身是符号链接，拒绝写入：${relativeFilePath}`);
        }
    } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
    }

    // 5. 真实路径复核（防 mkdir 后父目录仍是链接）
    const realParentDir = await fs.realpath(parentDir);
    if (!realParentDir.startsWith(root + path.sep) && realParentDir !== root) {
        throw new Error(`[安全拦截] 目标文件的真实父目录越权：${relativeFilePath}`);
    }

    await fs.writeFile(targetPath, content, 'utf-8');
}

/** 审查阶段的安全读取：目标必须是工作区内普通文件，且路径经过符号链接校验。 */
async function safeReadForReview(workspaceDir: string, relPath: string): Promise<string> {
    const { target } = await resolveInsideWorkspaceReal(workspaceDir, relPath);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`[安全拦截] 审查目标为符号链接：${relPath}`);
    if (!stat.isFile()) throw new Error(`[安全拦截] 审查目标不是普通文件：${relPath}`);
    const realTarget = await fs.realpath(target);
    return fs.readFile(realTarget, 'utf-8');
}

/** 同 safeReadForReview，但返回 Buffer（锁文件摘要用）。 */
async function safeReadBufferForReview(workspaceDir: string, relPath: string): Promise<Buffer> {
    const { target } = await resolveInsideWorkspaceReal(workspaceDir, relPath);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`[安全拦截] 审查目标为符号链接：${relPath}`);
    if (!stat.isFile()) throw new Error(`[安全拦截] 审查目标不是普通文件：${relPath}`);
    return fs.readFile(await fs.realpath(target));
}

async function safeCleanWorkspace(workspaceDir: string) {
    const safeDir = path.resolve(workspaceDir);
    const entries = await fs.readdir(safeDir, { withFileTypes: true });
    for (const entry of entries) {
        if (CLEAN_PROTECTED_PATTERNS.some(p => p.test(entry.name))) continue;
        const fullPath = path.join(safeDir, entry.name);
        if (entry.isDirectory()) await fs.rm(fullPath, { recursive: true, force: true });
        else await fs.unlink(fullPath);
    }
}

// ================= 测试后对账（安全不变量 6：审查对象 === 最终交付物） =================
/**
 * F1：忽略集只在【根目录】生效（相对路径无分隔符）。子目录里的同名条目
 * （如 nested/node_modules/...、sub/.git/...）不忽略，正常纳入对账与审查——
 * 否则测试可以在嵌套 node_modules 里投放文件而完全绕过对账。
 * `.dacw-workspace` 是 DACW 自己的根级标记文件，根层级忽略即可，无内容风险。
 */
const ROOT_DIGEST_IGNORED = new Set(['.dacw-workspace']);
/**
 * F2：根级 .git / node_modules 不是「无害」——按「存在性 + 顶层条目列表 + 摘要」
 * 单独对账（fingerprintProtectedDirs），不递归内容；测试若增删顶层条目 → 转人工。
 */
const PROTECTED_ROOT_DIRS = ['.git', 'node_modules'];

/**
 * 递归枚举工作区，返回「相对路径（统一用 / 分隔）→ 文件内容 SHA256」。
 * 安全语义：遇到符号链接或非普通文件项直接抛错（fail-closed）——对账对象必须可
 * 完整、确定地枚举；忽略仅在根级成立（F1），根级 .git / node_modules 交由
 * fingerprintProtectedDirs 做指纹对账（F2），不递归其内容。
 */
export async function enumerateWorkspace(root: string): Promise<Map<string, string>> {
    const resolvedRoot = path.resolve(root);
    const rootStat = await fs.lstat(resolvedRoot);
    if (rootStat.isSymbolicLink()) throw new Error(`[安全拦截] 工作区根目录是符号链接，拒绝枚举：${resolvedRoot}`);
    if (!rootStat.isDirectory()) throw new Error(`[安全拦截] 工作区根路径不是目录，拒绝枚举：${resolvedRoot}`);

    const digest = new Map<string, string>();
    const walk = async (dir: string, relPrefix: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));   // 稳定顺序，便于对账与断言
        const atRoot = relPrefix === '';
        for (const entry of entries) {
            // F1：忽略只在根级成立，子目录同名条目不忽略。
            if (atRoot && ROOT_DIGEST_IGNORED.has(entry.name)) continue;
            // F2：根级 .git / node_modules 不进入文件摘要（单独做顶层条目指纹）。
            if (atRoot && PROTECTED_ROOT_DIRS.includes(entry.name)) continue;
            const full = path.join(dir, entry.name);
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) throw new Error(`[安全拦截] 工作区包含符号链接，拒绝枚举：${rel}`);
            if (entry.isDirectory()) {
                await walk(full, rel);
                continue;
            }
            if (!entry.isFile()) throw new Error(`[安全拦截] 工作区包含非普通文件项，拒绝枚举：${rel}`);
            const buffer = await fs.readFile(full);
            digest.set(rel, crypto.createHash('sha256').update(buffer).digest('hex'));
        }
    };
    await walk(resolvedRoot, '');
    return digest;
}

/**
 * F2：根级受保护目录（.git / node_modules）指纹 =「存在性 + 顶层条目列表 + 摘要」。
 * 只读顶层 dirent，不递归内容、不跟随符号链接；目录不存在则不记录（缺失/新建由
 * diffDigest 的 - / + 表达）。测试期增删顶层条目（或创建/删除整个目录）都会改变
 * 指纹 → 对账转人工。
 */
export async function fingerprintProtectedDirs(
    root: string,
    names: string[] = PROTECTED_ROOT_DIRS,
): Promise<Map<string, string>> {
    const resolvedRoot = path.resolve(root);
    const fingerprints = new Map<string, string>();
    for (const name of names) {
        let entries;
        try {
            entries = await fs.readdir(path.join(resolvedRoot, name), { withFileTypes: true });
        } catch (e: any) {
            if (e && e.code === 'ENOENT') continue;
            throw new Error(`[安全拦截] 无法读取根级受保护目录 ${name} 的顶层条目：${e?.message ?? String(e)}`);
        }
        const listing = entries
            .map((entry) => {
                const kind = entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : entry.isSymbolicLink() ? 'l' : 'o';
                return `${kind}:${entry.name}`;
            })
            .sort()
            .join('\n');
        fingerprints.set(name, crypto.createHash('sha256').update(listing, 'utf8').digest('hex'));
    }
    return fingerprints;
}

/**
 * 对比两份「相对路径 → SHA256」摘要，输出三类差异：
 *   + 新增（post 有、base 无）；- 删除（base 有、post 无）；~ 内容变更（两边都有但哈希不同）。
 * 每条含文件路径与原因；输出按路径稳定排序。
 */
export function diffDigest(base: Map<string, string>, post: Map<string, string>): string[] {
    const entries: { kind: '+' | '-' | '~'; rel: string }[] = [];
    for (const [rel, digest] of post) {
        const before = base.get(rel);
        if (before === undefined) entries.push({ kind: '+', rel });
        else if (before !== digest) entries.push({ kind: '~', rel });
    }
    for (const rel of base.keys()) {
        if (!post.has(rel)) entries.push({ kind: '-', rel });
    }
    const order = { '+': 0, '-': 1, '~': 2 } as const;
    entries.sort((a, b) => (a.rel === b.rel ? order[a.kind] - order[b.kind] : (a.rel < b.rel ? -1 : 1)));
    return entries.map(({ kind, rel }) => {
        if (kind === '+') return `+ 新增：${rel}（测试后出现，基线/快照中不存在）`;
        if (kind === '-') return `- 删除：${rel}（基线/快照中存在，测试后消失）`;
        return `~ 内容变更：${rel}（测试后内容与基线/快照不一致）`;
    });
}

/** 差异摘要的展示上限：避免超大差异把结果消息撑爆（完整条数仍在 total 中报告）。 */
function formatDigestDiff(diffs: string[], maxEntries = 20): string {
    const shown = diffs.slice(0, maxEntries).join('\n');
    return diffs.length > maxEntries ? `${shown}\n...（其余 ${diffs.length - maxEntries} 条差异已省略）` : shown;
}

const workspaceLocks = new Map<string, Promise<void>>();

/**
 * 引擎入口：注入宿主能力，返回 `executeTask(taskId, workspaceDir, taskPrompt)`。
 * `options` 可覆盖 CONFIG 默认值；同一工作区的任务在进程内串行执行。
 */
export function apply(context: DSHContext, options?: Partial<EngineOptions>) {
    const resolved = resolveEngineOptions(options);
    return async function executeTask(rawTaskId: string, workspaceDir: string, taskPrompt: string) {
        const lockKey = path.resolve(workspaceDir);
        const prev = workspaceLocks.get(lockKey) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const chained = prev.then(() => gate);
        workspaceLocks.set(lockKey, chained);
        await prev;
        try { return await runWorkflow(context, rawTaskId, workspaceDir, taskPrompt, resolved); }
        finally {
            release();
            if (workspaceLocks.get(lockKey) === chained) workspaceLocks.delete(lockKey);
        }
    };
}

// ================= 结构化裁决协议 =================
type ReviewVerdict = { verdict: 'PASS' | 'REJECTED'; reasons: string[] };

export function parseReviewVerdict(raw: string): ReviewVerdict | null {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        const obj = JSON.parse(raw.slice(start, end + 1));
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
        const v = (obj as any).verdict;
        if (v !== 'PASS' && v !== 'REJECTED') return null;
        const r = (obj as any).reasons;
        if (r !== undefined && !Array.isArray(r)) return null;
        return { verdict: v, reasons: Array.isArray(r) ? r.map((x: unknown) => String(x)) : [] };
    } catch { return null; }
}

const SUSPICIOUS_RE = /\b(REJECTED|BYPASS\w*)\b/i;

const REVIEWER_PROMPT =
    '请进行防御性、安全、边界与需求符合性审查。逐文件审计，特别留意 package.json 的 scripts 字段' +
    '（postinstall/test 等脚本是任意命令执行的持久化载体）与 setup.py/pyproject.toml 的构建钩子。' +
    '注意：你的审查发生在测试执行之后，不是执行前的安全屏障；发现恶意或可疑脚本仍必须 REJECTED 并写明理由。' +
    '审查完成后，你必须只输出一个 JSON 对象（可置于代码围栏中），' +
    '格式为 {"verdict":"PASS"} 或 {"verdict":"REJECTED","reasons":["问题1","问题2"]}；' +
    '禁止输出任何其他判定性文字。PASS 仅表示你确认代码无安全、越权、边界问题，且完整实现了任务需求。';

// [漏洞9修复] 嗅探补齐 pyproject.toml 和 setup.py，精简参数
function sniffTestCommand(workspaceDir: string): { command: string; args: string[] } {
    const safeDir = path.resolve(workspaceDir);

    if (fsSync.existsSync(path.join(safeDir, 'package.json'))) {
        return { command: 'npm', args: ['run', 'test'] };
    }
    if (fsSync.existsSync(path.join(safeDir, 'requirements.txt')) ||
        fsSync.existsSync(path.join(safeDir, 'pyproject.toml')) ||
        fsSync.existsSync(path.join(safeDir, 'setup.py'))) {
        return { command: 'pytest', args: ['-q'] };
    }
    if (fsSync.existsSync(path.join(safeDir, 'Cargo.toml'))) {
        return { command: 'cargo', args: ['test', '--quiet'] };
    }
    if (fsSync.existsSync(path.join(safeDir, 'go.mod'))) {
        return { command: 'go', args: ['test', './...'] };
    }
    return { command: 'npm', args: ['run', 'test'] };
}

// ================= 写手增量解析与基线管理 =================
interface WriterDelta {
    changed: { file: string; code: string }[];
    deleted: string[];
    legacyFull: boolean;
}

function extractJsonCandidates(cleanRaw: string): string[] {
    const candidates: string[] = [];
    const fence = cleanRaw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) candidates.push(fence[1]);
    {
        let s = cleanRaw.indexOf('[');
        let e = cleanRaw.lastIndexOf(']');
        if (s === -1 || e === -1 || e <= s) {
            s = cleanRaw.indexOf('{');
            e = cleanRaw.lastIndexOf('}');
        }
        if (s !== -1 && e !== -1 && e > s) candidates.push(cleanRaw.substring(s, e + 1));
    }
    candidates.push(cleanRaw);
    return candidates;
}

function validateWriterItem(item: unknown): { file: string; code: string } {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('JSON 数组项必须为对象');
    const it = item as Record<string, unknown>;
    if (typeof it.file !== 'string' || !it.file || typeof it.code !== 'string') {
        throw new Error(`字段非法：file 必须为非空字符串，code 必须为字符串（可为空）`);
    }
    return { file: it.file, code: it.code };
}

export function parseWriterDelta(raw: string, maxChars: number = DEFAULT_ENGINE_OPTIONS.writerOutputMaxChars): WriterDelta {
    const cleanRaw = raw.trim();
    if (cleanRaw.length > maxChars) {
        throw new Error(`写手输出超出上限（${maxChars} 字符）`);
    }
    let parsed: unknown = null;
    let parseErr: unknown = null;
    for (const cand of extractJsonCandidates(cleanRaw)) {
        try { parsed = JSON.parse(cand); parseErr = null; break; } catch (e) { parseErr = e; }
    }
    if (parsed === null) throw new Error(`无法从写手输出解析 JSON：${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    if (Array.isArray(parsed)) return { changed: parsed.map(validateWriterItem), deleted: [], legacyFull: true };
    if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.changed) || Array.isArray(obj.deleted)) {
            const changed: { file: string; code: string }[] = [];
            for (const item of (Array.isArray(obj.changed) ? obj.changed : [])) changed.push(validateWriterItem(item));
            const deleted: string[] = [];
            for (const d of (Array.isArray(obj.deleted) ? obj.deleted : [])) {
                if (typeof d !== 'string' || !d) throw new Error('deleted 数组项必须为非空字符串');
                deleted.push(d);
            }
            return { changed, deleted, legacyFull: false };
        }
        if (typeof obj.file === 'string' && typeof obj.code === 'string') return { changed: [{ file: obj.file, code: obj.code }], deleted: [], legacyFull: true };
    }
    throw new Error('输出形态无法识别：需要 {"changed":[{"file","code"}],"deleted":[...]} 或旧版 [{"file","code"}] 数组');
}

function buildManifest(baseFiles: Map<string, string>, maxEntries: number): string {
    if (baseFiles.size === 0) return '(空——本轮需产出全部文件)';
    const lines: string[] = [];
    let n = 0;
    for (const [file, code] of baseFiles) {
        if (n >= maxEntries) { lines.push(`...（其余 ${baseFiles.size - n} 个文件略）`); break; }
        const sha8 = crypto.createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 8);
        lines.push(`${file} (${Buffer.byteLength(code, 'utf8')}B sha8:${sha8})`);
        n++;
    }
    return lines.join('\n');
}

function buildWriterPrompt(taskPrompt: string, baseFiles: Map<string, string>, feedback: string | null, maxManifestEntries: number): string {
    const rule =
        '[🚨 输出协议 v2] 相对当前文件基线，只输出【变更】：\n' +
        '{"changed":[{"file":"路径/文件.py","code":"完整文件内容"}],"deleted":["要删除的文件.js"]}\n' +
        '- changed：新增或修改的文件；code 必须是【完整文件内容】，严禁 diff/补丁/省略号截断；\n' +
        '- deleted：需要删除的文件（相对路径）；\n' +
        '- 未提及的文件由环境原样保留，严禁重复输出未变更文件；\n' +
        '- 也兼容旧版全量格式：直接输出 [{"file":...,"code":...}] 数组（包含所有文件）。';
    const base = `[当前文件基线]\n${buildManifest(baseFiles, maxManifestEntries)}`;
    return feedback ? `${taskPrompt}\n\n${rule}\n\n${base}\n\n${feedback}` : `${taskPrompt}\n\n${rule}\n\n${base}`;
}

/** 按“送入模型的总字符数”计算自适应聊天超时（写手按基线、审查者按送审 payload）。 */
function chatTimeoutForChars(totalChars: number, options: EngineOptions): number {
    const extra = Math.floor(totalChars / 10_000) * options.chatTimeoutPer10kCharsMs;
    return Math.min(options.chatTimeoutBaseMs + extra, options.chatTimeoutMaxMs);
}

function chatTimeoutFor(baseFiles: Map<string, string>, options: EngineOptions): number {
    let totalChars = 0;
    for (const code of baseFiles.values()) totalChars += code.length;
    return chatTimeoutForChars(totalChars, options);
}

async function runWorkflow(context: DSHContext, rawTaskId: string, workspaceDir: string, taskPrompt: string, options: EngineOptions) {
    const startTime = Date.now();
    logSystem(context, '启动 DACW (防御性智能体编程工作流, 输出协议 v2)...');
    logModelConfig(context, options.roleModels);
    const STATE_DIR = options.stateDir ?? path.join(os.tmpdir(), 'dacw-state');
    const RUN_KEY = crypto.randomBytes(32);
    const stateManager = new StateManager(STATE_DIR, rawTaskId, workspaceDir, RUN_KEY);

    // 沙盒策略在 stateManager.init 之后解析：blocked 时需要记录 NEED_HUMAN 状态并等待人类确认。
    let sandboxPlan: ExecutionPolicy;
    let sandboxDisabledByConsent = false;
    let runner: Runner;

    let baseFiles = new Map<string, string>();
    /** 对账后的最终交付清单；null 表示本轮尚未完成对账（此时回退到写手基线清单）。 */
    let finalFiles: string[] | null = null;
    const conversation: ConversationOps = NOOP_CONVERSATION;
    let feedback: string | null = null;
    const files = () => finalFiles ?? Array.from(baseFiles.keys());
    const finish = (success: boolean, message: string, round: number) =>
        ({ success, message, status: 'NEED_HUMAN' as const, round, files: files() });
    const abortError = () => {
        const err = new Error('工作流已被取消（调用方中断）');
        (err as any).isAbort = true;
        return err;
    };

    try {
        await stateManager.init(taskPrompt);

        // 测试执行策略只解析一次（默认 host 不探测 Docker；仅显式 auto/docker 才探测）。
        // auto：Docker 不可用时通过宿主交互 seam（ctx.userQuestions）询问是否关闭沙盒；
        // docker：显式要求容器，不可用时直接拒绝运行（不询问、不降级）。
        sandboxPlan = await resolveExecutionPolicy(options.sandbox, options.sandboxDetect ?? detectDocker);
        logSystem(context, `🛡️ 测试执行策略：${describePolicy(sandboxPlan)}`);
        if (sandboxPlan.kind === 'blocked' && sandboxPlan.mode === 'auto') {
            const consentRequest = buildSandboxConsentRequest(sandboxPlan);
            logError(context, `[沙盒] ${consentRequest.message}\n${consentRequest.detail}`);
            let consent: SandboxConsentResult;
            if (typeof context.askUserQuestion === 'function') {
                try {
                    consent = await context.askUserQuestion(consentRequest);
                } catch (e: any) {
                    consent = { decision: 'unavailable', reason: `交互确认失败：${e?.message ?? String(e)}` };
                }
            } else {
                consent = { decision: 'unavailable', reason: '宿主未提供交互确认能力（ctx.userQuestions 不可用）' };
            }
            if (consent.decision === 'disable_sandbox') {
                sandboxDisabledByConsent = true;
                sandboxPlan = { kind: 'host' };
                logError(context, '[安全降级] 用户已确认关闭沙盒模式：本次运行将以宿主用户全权限执行 AI 生成的测试代码，直接接触宿主系统。');
            } else {
                const why = consent.decision === 'keep_sandbox' ? '用户选择保持沙盒模式（取消本次运行）' : consent.reason;
                const message = `${consentRequest.message}\n${consentRequest.detail}\n处理结果：未关闭沙盒（${why}）。`
                    + '已拒绝运行，未在宿主执行任何测试代码。可安装/启动 Docker 后重试；'
                    + '或在明确接受风险后显式设置 config.sandbox.mode: "host"（宿主直执，无隔离）。';
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = '沙盒不可用且未获关闭确认，测试未执行'; });
                logError(context, message);
                return finish(false, message, 0);
            }
        } else if (sandboxPlan.kind === 'blocked') {
            // docker（显式要求容器）：不可用时直接拒绝，不进入交互询问、不降级。
            const message = `sandbox.mode="docker" 要求容器执行，但 Docker 不可用：${sandboxPlan.reason}。`
                + '已拒绝运行，未在宿主执行任何测试代码（不询问、不静默降级）。'
                + '请安装/启动 Docker 后重试；或显式设置 sandbox.mode: "auto"（不可用时交互确认）或 "host"（接受宿主执行风险）。';
            await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = 'docker 模式不可用，测试未执行'; });
            logError(context, message);
            return finish(false, message, 0);
        }
        runner = new Runner(workspaceDir, sandboxPlan);
        if (sandboxPlan.kind === 'host' && !sandboxDisabledByConsent && options.sandboxExplicit) {
            logError(context, '[警告] 你显式配置了 sandbox.mode="host"：测试将以宿主用户全权限直接执行（无隔离），'
                + '写手产出的任意代码——包括 package.json 的 test/pretest 等脚本——都将在你的账号下运行。'
                + '子代理工具隔离与审查者审计均不构成对测试进程的约束。');
        }

        for (let round = 1; round <= options.maxRounds; round++) {
            await stateManager.update((s) => { s.round = round; });
            finalFiles = null;
            conversation.checkpoint();

            // 1. 写手阶段
            logProgress(context, round, options.maxRounds, startTime, '写手思考中...');
            const writerOutcome = await safeChat(
                context, 'writer-agent',
                buildWriterPrompt(taskPrompt, baseFiles, feedback, options.manifestMaxEntries),
                '', chatTimeoutFor(baseFiles, options), options.chatMaxAttempts);

            if (!writerOutcome.ok) {
                if (writerOutcome.aborted) throw abortError();
                logError(context, `写手调用失败：${writerOutcome.reason}`);
                feedback = `[系统警告] 写手调用失败：${writerOutcome.reason}。\n请严格按输出协议 v2 输出 JSON。`;
                await stateManager.update((s) => { s.lastError = `写手阶段调用失败：${writerOutcome.reason}`; });
                await conversation.discardSinceCheckpoint();
                continue;
            }

            // 2. 解析 + 合并 + 落盘
            let delta: WriterDelta;
            try {
                delta = parseWriterDelta(writerOutcome.text, options.writerOutputMaxChars);
            } catch (e: any) {
                logError(context, `写手输出解析失败：${e.message}`);
                feedback = `[系统警告] 上一次写手阶段输出无法解析：${e.message}。\n请务必严格按输出协议 v2 输出合法 JSON（兼容旧版全量数组）。`;
                await stateManager.update((s) => { s.lastError = `写手阶段崩溃：${e.message}`; });
                await conversation.discardSinceCheckpoint();
                continue;
            }

            try {
                // 全量模式替换整个基线；受保护文件删除拦截——逻辑收敛于可测的 mergeDelta
                const nextBase = mergeDelta(baseFiles, delta, workspaceDir);

                // 清理后写入整个合并集（不变量：工作区内容 === 基线合并集）
                await safeCleanWorkspace(workspaceDir);
                for (const [rel, content] of nextBase) {
                    await safeWriteFile(workspaceDir, rel, content);
                }
                baseFiles = nextBase;

                logSuccess(context, delta.legacyFull
                    ? `写手已输出全量 ${delta.changed.length} 个文件（旧版格式，基线替换）`
                    : `写手输出变更：+改 ${delta.changed.length} 个，-删 ${delta.deleted.length} 个（基线共 ${baseFiles.size} 文件）`);
                await stateManager.update((s) => { s.writtenFiles = buildManifest(baseFiles, options.manifestMaxEntries).replace(/\n/g, ', '); });
            } catch (e: any) {
                logError(context, `写手输出合并/落盘失败：${e.message}`);
                // 清理或写入中途失败 => 工作区与基线可能不一致；继续运行只会测试残缺工作区，fail-closed 转人工
                throw new Error(`工作区落盘崩溃，一致性已破坏：${e.message}`);
            }

            // 3. 测试前快照（不变量 6 的基准）：测试不得改变工作区任何已有内容。
            //    baseDigest 来自写手基线（内存），preDigest 是测试前工作区快照（基线 ∪ 地基文件，
            //    如 package.json）——以快照为期望状态，否则地基文件会被 diff 误判为"新增"。
            const baseDigest = new Map<string, string>();
            for (const [rel, content] of baseFiles) {
                baseDigest.set(rel.split(path.sep).join('/'), crypto.createHash('sha256').update(content, 'utf8').digest('hex'));
            }
            let preDigest: Map<string, string>;
            let preProtected: Map<string, string>;
            try {
                preDigest = await enumerateWorkspace(workspaceDir);
                preProtected = await fingerprintProtectedDirs(workspaceDir);
            } catch (e: any) {
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = `测试前快照失败：${e.message}`; });
                logError(context, `测试前快照失败（工作区不可完整枚举），强制转人工：${e.message}`);
                return finish(false, `无法建立测试前快照（工作区不可完整枚举），需人工介入：${e.message}`, round);
            }
            const baselineMismatch: string[] = [];
            for (const [rel, digest] of baseDigest) {
                if (preDigest.get(rel) !== digest) baselineMismatch.push(rel);
            }
            if (baselineMismatch.length > 0) {
                const detail = baselineMismatch.slice(0, 20).join(', ')
                    + (baselineMismatch.length > 20 ? ` …（共 ${baselineMismatch.length} 个）` : '');
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = `落盘后基线校验失败：${detail}`; });
                logError(context, `落盘后基线校验失败（工作区与基线不一致），强制转人工：${detail}`);
                return finish(false, `写入后的工作区与基线不一致（${baselineMismatch.length} 个文件），需人工介入：${detail}`, round);
            }

            // 4. 运行机阶段
            logProgress(context, round, options.maxRounds, startTime, '运行机测试中...');
            const sniffed = sniffTestCommand(workspaceDir);
            const testRun = await runner.run(sniffed.command, sniffed.args);
            await stateManager.update((s) => { s.testResult = testRun.output; });

            if (!testRun.success) {
                logError(context, `测试未通过，打回重写。运行机输出：\n${testRun.output}`);
                const timeoutHint = testRun.timedOut ? '\n[注意] 本次为执行超时，请检查是否存在死循环、阻塞式 I/O 或等待用户输入。' : '';
                feedback = `[上一轮测试失败日志，请修复]${timeoutHint}\n${testRun.output}`;
                continue;
            }
            logSuccess(context, '测试通过！');

            // 5. 测试后对账（不变量 6）：测试可能改写工作区，审查对象必须 === 最终交付物。
            logProgress(context, round, options.maxRounds, startTime, '测试后对账中...');
            let postDigest: Map<string, string>;
            let postProtected: Map<string, string>;
            try {
                postDigest = await enumerateWorkspace(workspaceDir);
                postProtected = await fingerprintProtectedDirs(workspaceDir);
            } catch (e: any) {
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = `测试后对账失败：${e.message}`; });
                logError(context, `测试后对账失败（最终交付物不可完整枚举），强制转人工：${e.message}`);
                return finish(false, `测试后无法枚举最终交付物（工作区不可完整枚举），需人工介入：${e.message}`, round);
            }
            const digestDiff = diffDigest(preDigest, postDigest);
            if (digestDiff.length > 0) {
                const message = `测试后对账不通过：测试执行改变了交付物（${digestDiff.length} 处差异），`
                    + `已阻止进入审查，需人工介入。\n${formatDigestDiff(digestDiff)}`;
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = message; });
                logError(context, message);
                return finish(false, message, round);
            }
            // F2：根级 .git / node_modules 的「存在性 + 顶层条目列表」指纹对账（不递归内容）。
            const protectedDiff = diffDigest(preProtected, postProtected);
            if (protectedDiff.length > 0) {
                const message = `测试后对账不通过：根级受保护目录（.git / node_modules）在测试期被改动`
                    + `（${protectedDiff.length} 处差异），已阻止进入审查，需人工介入。\n${formatDigestDiff(protectedDiff)}`;
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = message; });
                logError(context, message);
                return finish(false, message, round);
            }
            finalFiles = Array.from(postDigest.keys());
            logSuccess(context, `测试后对账通过：${postDigest.size} 个交付文件与基线一致`);

            // 6. 审查阶段
            logProgress(context, round, options.maxRounds, startTime, '审查员代码审计中...');
            let actualCodes = '';
            let readFailed = false;
            let readErrorMsg = '';
            let reviewTruncated = false;   // 审查输入被字符上限截断（单文件 / 总输入）
            let reviewPartial = false;     // G2：锁文件只送 SHA256 摘要——不构成语义审查
            /** F3：记录审查循环实际遍历到的键集（与 postDigest / finalFiles 做三边界一致性断言）。 */
            const iteratedKeys: string[] = [];
            /** 敏感文件默认不送模型审查：记录被排除的键（文件仍交付，finalFiles 保留完整清单）。 */
            const reviewExcluded = new Set<string>();
            /** G1：截断/未送审明细，用于 fail-closed 说明。 */
            const truncatedFiles: string[] = [];
            const unreviewedFiles: string[] = [];
            const lockDigestFiles: string[] = [];

            // 审查输入有上限：超出时按文件头截断并在 payload 中显式标记，避免超大工作区
            // 把审查请求撑爆（或超时）却误报为“达到最大轮次”。
            const appendReviewChunk = (chunk: string): boolean => {
                const remaining = options.reviewInputMaxChars - actualCodes.length;
                if (chunk.length <= remaining) {
                    actualCodes += chunk;
                    return true;
                }
                if (remaining > 200) actualCodes += chunk.slice(0, remaining) + '\n[...DACW 审查输入达到上限，后续内容已截断...]';
                else actualCodes += '\n[...DACW 审查输入达到上限，余下内容未送入审查...]';
                reviewTruncated = true;
                logError(context, `审查输入超过 ${options.reviewInputMaxChars} 字符上限，已截断；结论将附带人工确认提示。`);
                return false;
            };
            const appendReviewFile = (label: string, code: string): boolean => {
                let capped = code;
                if (code.length > options.reviewFileMaxChars) {
                    capped = code.slice(0, options.reviewFileMaxChars)
                        + `\n[...DACW 单文件超过 ${options.reviewFileMaxChars} 字符，已截断...]`;
                    reviewTruncated = true;
                    truncatedFiles.push(`${label}（截断于 ${options.reviewFileMaxChars} 字符，原文件 ${code.length} 字符）`);
                }
                return appendReviewChunk(`\n\n--- 文件: ${label} ---\n${capped}`);
            };
            /** G1：截断/摘要送审的完整说明——未送审文件、单文件截断位置、总输入上限。 */
            const describeReviewIncompleteness = (): string => {
                const lines: string[] = [];
                lines.push(`审查不完整：reviewTruncated=${reviewTruncated}，reviewPartial=${reviewPartial}。`);
                if (unreviewedFiles.length > 0) {
                    const shown = unreviewedFiles.slice(0, 20).join(', ');
                    lines.push(`未送审文件（${unreviewedFiles.length}）：${shown}${unreviewedFiles.length > 20 ? ' …' : ''}`);
                }
                if (truncatedFiles.length > 0) {
                    const shown = truncatedFiles.slice(0, 20).join('；');
                    lines.push(`单文件截断（${truncatedFiles.length}）：${shown}${truncatedFiles.length > 20 ? ' …' : ''}`);
                }
                if (lockDigestFiles.length > 0) {
                    lines.push(`仅摘要送审的锁文件（${lockDigestFiles.length}）：${lockDigestFiles.join(', ')}`
                        + '（锁文件完整性由测试前后 SHA256 对账保证，未送语义审查）');
                }
                lines.push(`总输入上限：${actualCodes.length}/${options.reviewInputMaxChars} 字符`
                    + (actualCodes.length >= options.reviewInputMaxChars ? '（已达上限）' : ''));
                return lines.join('\n');
            };

            try {
                const reviewed = new Set<string>();
                const reviewKeys = Array.from(postDigest.keys());
                // 审查输入只来自对账后的最终清单（不变量 6）；每个文件都从磁盘读当前内容，不复用内存基线。
                for (let i = 0; i < reviewKeys.length; i += 1) {
                    const rel = reviewKeys[i];
                    const relDisplay = rel.split(path.sep).join('/');
                    // 敏感文件：内容不进入审查输入（仍交付、仍在 files 清单中），记入 reviewExcluded 供 F3 与 message 使用。
                    if (isSensitiveReviewFile(relDisplay)) {
                        reviewExcluded.add(relDisplay);
                        logError(context, `[审查排除] 敏感文件未送入模型审查：${relDisplay}（仍在交付清单中，请人工审阅）`);
                        continue;
                    }
                    iteratedKeys.push(rel);
                    // 锁文件只送 SHA256 摘要（下方单独处理），避免超大文件挤占审查输入
                    if (LOCK_REVIEW_DIGEST_SET.has(relDisplay)) continue;
                    try {
                        const code = await safeReadForReview(workspaceDir, rel);
                        if (!appendReviewFile(relDisplay, code)) {
                            // G1：总输入上限截断——记录当前文件与其余未送审文件（fail-closed 明细）。
                            truncatedFiles.push(`${relDisplay}（受总输入上限 ${options.reviewInputMaxChars} 字符限制，未能完整送审）`);
                            const remainingKeys = reviewKeys.slice(i + 1).map((key) => key.split(path.sep).join('/'));
                            // 敏感文件不会因截断改变"不送审"的原因（敏感排除）；补记到 reviewExcluded，
                            // 且不进入 "未送审（审查输入上限）" 清单，避免 allowTruncatedReview 放行时标注错因。
                            for (const key of remainingKeys) {
                                if (isSensitiveReviewFile(key)) reviewExcluded.add(key);
                            }
                            unreviewedFiles.push(...remainingKeys.filter((key) => !isSensitiveReviewFile(key)));
                            break;
                        }
                        reviewed.add(relDisplay);
                    } catch (e: any) {
                        readFailed = true;
                        readErrorMsg = `读取文件 ${relDisplay} 失败: ${e.message}`;
                        break;
                    }
                }

                if (!readFailed) {
                    for (const f of FOUNDATION_REVIEW_FILES) {
                        if (reviewed.has(f)) continue;
                        if (!fsSync.existsSync(path.join(path.resolve(workspaceDir), f))) continue;
                        try {
                            const code = await safeReadForReview(workspaceDir, f);
                            if (!appendReviewFile(`${f}（地基文件）`, code)) {
                                truncatedFiles.push(`${f}（地基文件，受总输入上限 ${options.reviewInputMaxChars} 字符限制）`);
                                break;
                            }
                            reviewed.add(f);
                        } catch (e: any) {
                            readFailed = true;
                            readErrorMsg = `读取地基文件 ${f} 失败: ${e.message}`;
                            break;
                        }
                    }
                    // [N-2] 锁文件只送 SHA256 摘要；G2：摘要送审不构成语义审查，标记 reviewPartial 并记录明细。
                    for (const f of LOCK_REVIEW_DIGEST_FILES) {
                        if (!fsSync.existsSync(path.join(path.resolve(workspaceDir), f))) continue;
                        try {
                            const digest = crypto.createHash('sha256').update(await safeReadBufferForReview(workspaceDir, f)).digest('hex');
                            lockDigestFiles.push(f);
                            reviewPartial = true;
                            if (!appendReviewChunk(`\n\n--- 文件: ${f}（SHA256 摘要，全文过长不送审） ---\n${digest}`)) break;
                        } catch (e: any) {
                            readFailed = true;
                            readErrorMsg = `读取锁文件 ${f} 摘要失败: ${e.message}`;
                            break;
                        }
                    }
                }
            } catch (readErr: any) {
                readFailed = true;
                readErrorMsg = `意外错误: ${readErr.message}`;
            }

            if (readFailed) {
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = `审查前读取文件失败：${readErrorMsg}`; });
                logError(context, `审查前读取文件失败，强制转人工：${readErrorMsg}`);
                return finish(false, `审查前文件完整性校验失败，需人工介入：${readErrorMsg}`, round);
            }

            // 审计可追溯：审查阶段结束时把"因敏感被排除、未送模型审查"的文件清单写入状态。
            const excludedForAudit = Array.from(reviewExcluded).sort();
            await stateManager.update((s) => {
                s.reviewExcluded = excludedForAudit.length > 0 ? excludedForAudit : null;
            });

            // 零送审 fail-closed：没有任何文件送入模型审查（全部被敏感排除）→ 不放行 success:true。
            // 不依赖 allowTruncatedReview（该逃生门只覆盖截断/摘要，不覆盖"零语义审查"）。
            if (iteratedKeys.length === 0 && reviewExcluded.size > 0) {
                const message = `本次无任何文件送模型审查，全部需人工确认（${excludedForAudit.length} 个敏感文件被排除：`
                    + `${excludedForAudit.slice(0, 20).join(', ')}${excludedForAudit.length > 20 ? ' …' : ''}）。已拒绝 success:true。`;
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = message; });
                logError(context, message);
                return finish(false, message, round);
            }

            const reviewOutcome = await safeChat(
                context, 'reviewer-agent', REVIEWER_PROMPT,
                `任务需求如下：\n${taskPrompt}\n\n本次工作区的所有代码文件如下：\n${actualCodes}`,
                chatTimeoutForChars(actualCodes.length + taskPrompt.length, options), options.chatMaxAttempts);

            if (!reviewOutcome.ok) {
                if (reviewOutcome.aborted) throw abortError();
                logError(context, '审查接口异常，打回重写。');
                feedback = `[系统警告] 上一轮审查接口异常，请按输出协议 v2 输出本轮变更。`;
                continue;
            }

            const reviewResult = reviewOutcome.text;
            await stateManager.update((s) => { s.reviewResult = reviewResult; });

            const parsedVerdict = parseReviewVerdict(reviewResult);
            if (parsedVerdict === null) {
                logError(context, '审查输出不是合法裁决 JSON，按 REJECTED 处理，打回重写。');
                feedback = `[系统警告] 审查者输出格式非法，必须为 JSON {"verdict":"PASS"|"REJECTED"}，请修复后重新提交。`;
                continue;
            }

            if (parsedVerdict.verdict === 'REJECTED') {
                logError(context, '审查未通过（REJECTED），打回重写。');
                feedback = `[上一轮审查未通过（REJECTED），请修复]\n问题清单：${JSON.stringify(parsedVerdict.reasons)}\n（审查者原始输出：${reviewResult}）`;
                continue;
            }

            if (SUSPICIOUS_RE.test(reviewResult)) {
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; });
                logError(context, '审查 verdict 为 PASS，但包含可疑字样，转人工闸门。');
                return finish(false, '审查结果存在可疑信号（PASS 但含 REJECTED/BYPASS 字样），需人工确认', round);
            }

            // G1/G2/G3：截断 / 摘要送审的 fail-closed 闸门——默认配置下任何"审查不完整"都禁止 PASS。
            const reviewIncomplete = reviewTruncated || reviewPartial;
            const escapedIncomplete = reviewIncomplete && options.allowTruncatedReview === true;
            if (reviewIncomplete && !escapedIncomplete) {
                const detail = describeReviewIncompleteness();
                const message = `审查不完整，拒绝 success:true（默认 fail-closed）：\n${detail}\n`
                    + '放行必须显式设置 config.allowTruncatedReview: true（降低安全保证）；'
                    + '或缩小工作区 / 提高 reviewInputMaxChars、reviewFileMaxChars 后重试。';
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = message; });
                logError(context, message);
                return finish(false, message, round);
            }

            // F3：最终三边界一致性断言——`iteratedKeys ∪ reviewExcluded === postDigest.keys()`、
            // finalFiles 保留完整清单（敏感文件确实交付，只是不送审）；
            // 且审查结束再枚举必须与 postDigest（及受保护目录指纹）一致（防审查期间被变动）。
            // 任一不等一律 success:false 转人工，绝不放行 success:true。
            // （allowTruncatedReview=true 时允许审查不完整，但 finalFiles 与再枚举一致性仍然强制。）
            let recheckDigest: Map<string, string>;
            let recheckProtected: Map<string, string>;
            try {
                recheckDigest = await enumerateWorkspace(workspaceDir);
                recheckProtected = await fingerprintProtectedDirs(workspaceDir);
            } catch (e: any) {
                const message = `最终一致性校验失败（审查期间工作区不可完整枚举），需人工介入：${e.message}`;
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = message; });
                logError(context, message);
                return finish(false, message, round);
            }
            const boundaryProblems: string[] = [];
            const sameKeySet = (keys: string[], expected: Map<string, string>): boolean =>
                keys.length === expected.size && keys.every((key) => expected.has(key));
            // F3：审查覆盖 = 实际遍历键集 ∪ 敏感排除集，必须完整覆盖对账清单。
            const reviewedOrExcluded = new Set<string>([...iteratedKeys, ...reviewExcluded]);
            if (!escapedIncomplete && reviewedOrExcluded.size !== postDigest.size) {
                const missing = Array.from(postDigest.keys()).filter((key) => !reviewedOrExcluded.has(key));
                boundaryProblems.push(`审查覆盖与对账清单不一致（已审 ${iteratedKeys.length} + 敏感排除 ${reviewExcluded.size} / 清单 ${postDigest.size}；`
                    + '审查输入可能因字符上限被截断，不能视为完整审查）'
                    + (missing.length > 0 ? `；未覆盖：${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}` : ''));
            }
            if (finalFiles === null || !sameKeySet(finalFiles, postDigest)) {
                boundaryProblems.push('finalFiles 与 postDigest 不一致');
            }
            const reviewWindowDiff = diffDigest(postDigest, recheckDigest);
            if (reviewWindowDiff.length > 0) {
                boundaryProblems.push(`审查期间工作区文件发生变动：\n${formatDigestDiff(reviewWindowDiff)}`);
            }
            const reviewWindowProtected = diffDigest(postProtected, recheckProtected);
            if (reviewWindowProtected.length > 0) {
                boundaryProblems.push(`审查期间受保护目录顶层条目发生变动：\n${formatDigestDiff(reviewWindowProtected)}`);
            }
            if (boundaryProblems.length > 0) {
                const message = `最终一致性断言失败（${boundaryProblems.length} 项），拒绝 success:true，需人工介入。\n`
                    + boundaryProblems.join('\n');
                await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = message; });
                logError(context, message);
                return finish(false, message, round);
            }

            // G3 逃生门（显式开启时才存在）：放行不完整审查，但 message/日志/files 必须持续标注。
            if (escapedIncomplete && finalFiles !== null) {
                const annotate = new Map<string, string>();
                for (const label of truncatedFiles) {
                    const file = label.split('（')[0];
                    if (file && !annotate.has(file)) annotate.set(file, '审查输入被截断，未完整送审');
                }
                for (const file of unreviewedFiles) {
                    if (file && !annotate.has(file)) annotate.set(file, '未送审（审查输入上限）');
                }
                for (const file of lockDigestFiles) {
                    if (!annotate.has(file)) annotate.set(file, '仅摘要送审，未语义审查');
                }
                finalFiles = finalFiles.map((file) => (annotate.has(file) ? `${file}（${annotate.get(file)}）` : file));
                logError(context, '[安全降级] allowTruncatedReview=true：本次审查不完整（截断/仅摘要），仍按配置放行 success:true；'
                    + '该结果不构成完整审查保证，合入前必须人工确认未送审内容。');
            }

            await stateManager.update((s) => { s.status = 'NEED_HUMAN'; });
            logSuccess(context, '全链路通过！进入人工闸门审核。');
            const truncatedNote = escapedIncomplete
                ? '（【安全降级】审查不完整：allowTruncatedReview=true 放行了截断/仅摘要送审；未送审项已标注在 files 中）'
                : '';
            const sensitiveNote = reviewExcluded.size > 0
                ? `（敏感文件未送模型审查，请在合入前人工审阅：${Array.from(reviewExcluded).slice(0, 10).join(', ')}${reviewExcluded.size > 10 ? ' …' : ''}）`
                : '';
            const sandboxNote = sandboxPlan.kind === 'docker'
                ? '（测试在一次性容器内执行：无网络、只读根文件系统、非 root、资源受限）'
                : sandboxDisabledByConsent
                    ? '（【安全降级】用户已确认关闭沙盒：测试以宿主用户全权限执行——写手产出的代码已在你的账号下运行）'
                    : options.sandboxExplicit
                        ? '（警告：测试以宿主用户全权限执行——写手产出的代码已在你的账号下运行）'
                        : '（默认策略：测试以宿主用户权限执行，未做隔离）';
            return finish(true, `代码已通过机器测试与审查，需人工确认合入${sandboxNote}${truncatedNote}${sensitiveNote}`, round);
        }

        await stateManager.update((s) => { s.status = 'NEED_HUMAN'; });
        logError(context, `达到最大轮次 (${options.maxRounds})，需人工介入。`);
        return finish(false, `达到最大轮次 (${options.maxRounds})，需人工介入`, options.maxRounds);

    } catch (fatal: any) {
        if (isAbortError(fatal)) {
            logError(context, '工作流被调用方取消。');
            try { await stateManager.update((s) => { s.status = 'NEED_HUMAN'; s.lastError = '工作流被调用方取消'; }); } catch { }
            return finish(false, '工作流被调用方取消，未完成任何自动合入', 0);
        }
        logError(context, `[致命异常] ${fatal?.stack || fatal?.message || fatal}`);
        try {
            await stateManager.update((s) => {
                s.status = 'NEED_HUMAN';
                s.lastError = `[致命异常] ${fatal?.message ?? String(fatal)}`.trim();
            });
        } catch { }
        return finish(false, `工作流异常终止：${fatal?.message || '未知错误'}`, 0);
    }
}
