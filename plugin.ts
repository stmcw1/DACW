/**
 * DACW —— DSH Host 插件半边（另一半是 index.ts 的确定性协调器）。
 *
 * 本文件把 DACW 接到真实宿主能力上：
 *   1. 注册模型可调用的 `dacw_run` 工具（默认名，可由配置改）；
 *   2. 注册两个「纯 LLM」子代理 preset（dacw-writer / dacw-reviewer，persona-only）；
 *   3. 在 `agent/created` 上对 DACW 子代理执行【运行时工具隔离】：把宿主全局工具从子代理
 *      作用域里全部 deny 掉，并在子代理启动后校验隔离确实生效，未生效则拒绝运行——写手
 *      因此没有执行通道、审查者无法调用任何工具；
 *   4. 把协调器的 `chat(agentId, prompt, context)` 接到 `ctx.subagents.startActivation`
 *      （delivery: 'caller'，不向父会话注入完成通知），返回子代理最终文本。
 *
 * 不变量（与 SAFETY.md 对应）：
 *   - 工具隔离必须真实生效（见上）；preset 不可用或隔离失败时默认 fail-closed 拒绝运行。
 *     「无法确认隔离」同样是失败：provider 未返回有效 childId（无法确认隔离生效）、或子代理
 *     上下文缺少 tools.schemas（缺少验证能力）——一律先回收子代理再抛错，绝不记为成功；
 *     enforceChildToolIsolation=false 是唯一逃生门（用户显式接受风险），allowInheritedPresets
 *     仅用于允许继承父会话 preset，不改变隔离要求；
 *   - 工作区必须是空目录或带【本插件写入的合法】.dacw-workspace 标记目录，否则拒绝运行，
 *     防止误删用户文件；
 *   - 所有失败都抛错，不静默成功。
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { apply as createEngine } from './index';
import { DEFAULT_SANDBOX_CONFIG, normalizeSandboxConfig } from './sandbox';
import type { SandboxConfig } from './sandbox';

const PLUGIN_VERSION = '1.1.0';
const WRITER_PRESET_ID = 'dacw-writer';
const REVIEWER_PRESET_ID = 'dacw-reviewer';
const WORKSPACE_MARKER = '.dacw-workspace';
const WORKSPACE_MARKER_MANAGED_BY = '@stmcw1/dacw';
/** 0.1 时代的包名：保留对旧标记的兼容，避免升级后既有工作区无法继续使用。 */
const LEGACY_WORKSPACE_MARKER_MANAGED_BY = '@local/dacw';
const WORKSPACE_MARKER_CONTENT =
    `{"managedBy":"${WORKSPACE_MARKER_MANAGED_BY}","version":"${PLUGIN_VERSION}",` +
    `"note":"DACW resets non-foundation files in this directory every round. Remove this marker to revoke that."}\n`;

const MAX_TASK_CHARS = 20_000;
const MAX_TASK_ID_CHARS = 128;
const MAX_WORKSPACE_ARG_CHARS = 1_024;

const WRITER_PERSONA =
    '你是 DACW（防御性智能体编程工作流）的写手。你的唯一输出是符合「输出协议 v2」的 JSON 变更集：' +
    '不要调用任何工具，不要解释，不要输出 JSON 之外的任何文字。' +
    '收到任务与当前文件基线后，changed 里必须是【完整文件内容】（严禁 diff/补丁/省略号截断），' +
    '未提及的文件由环境原样保留。';
const REVIEWER_PERSONA =
    '你是 DACW（防御性智能体编程工作流）的审查者。你不写代码、不调用任何工具，只做防御性、安全、' +
    '边界与需求符合性审查。审查完成后，你必须只输出一个 JSON 对象：' +
    '{"verdict":"PASS"} 或 {"verdict":"REJECTED","reasons":["问题1","问题2"]}。' +
    '禁止输出任何其他判定性文字。';

/**
 * Cordis 插件级服务注入：`tools` 是注册 dacw_run 的必需服务；其余宿主服务
 * （subagents / agentPresets / workingDirectory）通过 ctx.get() 探测式获取，
 * 缺失时降级而不是让整个插件无法激活。
 */
export const inject = ['tools'];

/** 写手/审查者模型配置取值：null/"inherit" 继承父会话；"provider/model"；纯 "model"（按 DSH 已配置模型目录解析 provider）；或对象形式。 */
export interface ModelSpec {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
}
export type ModelConfigValue = null | string | ModelSpec;

/** Host 插件行的可配置项（`cordis.patch.yml` 的 row.config）。 */
export interface PluginConfig {
    toolName: string;
    workspace: string;
    workspacePolicy: 'guarded' | 'allow';
    maxRounds: number;
    subagentProvider: string;
    writerModel: ModelConfigValue;
    reviewerModel: ModelConfigValue;
    stateDir: string;
    chatTimeoutBaseMs: number;
    chatTimeoutPer10kCharsMs: number;
    chatTimeoutMaxMs: number;
    chatMaxAttempts: number;
    writerOutputMaxChars: number;
    manifestMaxEntries: number;
    allowInheritedPresets: boolean;
    enforceChildToolIsolation: boolean;
    /** 测试执行策略：默认 host（宿主直执，无隔离）；容器模式为可选配置（sandbox 分支）。 */
    sandbox: SandboxConfig;
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
    toolName: 'dacw_run',
    workspace: '',
    workspacePolicy: 'guarded',
    maxRounds: 3,
    subagentProvider: 'spawn',
    writerModel: null,
    reviewerModel: null,
    stateDir: '',
    chatTimeoutBaseMs: 120_000,
    chatTimeoutPer10kCharsMs: 20_000,
    chatTimeoutMaxMs: 300_000,
    chatMaxAttempts: 2,
    writerOutputMaxChars: 2_000_000,
    manifestMaxEntries: 400,
    allowInheritedPresets: false,
    enforceChildToolIsolation: true,
    sandbox: DEFAULT_SANDBOX_CONFIG,
};

function positiveIntOr(value: unknown, fallback: number, warnings: string[], field: string): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
    warnings.push(`config.${field} 非法（需要正整数），已回退默认值 ${fallback}`);
    return fallback;
}
function nonEmptyStringOr(value: unknown, fallback: string, warnings: string[], field: string): string {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'string') return value;
    warnings.push(`config.${field} 非法（需要字符串），已回退默认值`);
    return fallback;
}
function normalizeModelConfig(value: unknown, warnings: string[], field: string): ModelConfigValue {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text || text.toLowerCase() === 'inherit') return null;
        return text;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        warnings.push(`config.${field} 非法（需要字符串或 { provider, model }），已忽略`);
        return null;
    }
    const obj = value as Record<string, unknown>;
    const provider = typeof obj.provider === 'string' && obj.provider.trim() ? obj.provider.trim() : undefined;
    const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : undefined;
    const reasoningEffort = typeof obj.reasoningEffort === 'string' && obj.reasoningEffort.trim()
        ? obj.reasoningEffort.trim()
        : undefined;
    if (!provider && !model) {
        warnings.push(`config.${field} 需要至少提供 model（可只写模型名，由 DSH 已配置模型目录解析 provider），已忽略`);
        return null;
    }
    if (provider && !model) {
        warnings.push(`config.${field} 只有 provider 没有 model，运行时会 fail-closed 报错；请补 model 或删除该字段`);
        return { provider, ...(reasoningEffort ? { reasoningEffort } : {}) };
    }
    return {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
    };
}

/**
 * 合并并校验插件配置；非法字段回退默认值并记录警告（不抛错，避免一个错字导致插件无法激活）。
 * 纯函数，供回归自测。
 */
export function normalizePluginConfig(raw: unknown): { config: PluginConfig; warnings: string[]; sandboxExplicit: boolean } {
    const warnings: string[] = [];
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    // 只有用户显式写了 sandbox.mode === 'host' 才算"显式选择宿主执行"；默认值（host）不告警。
    const rawSandbox = input.sandbox;
    const sandboxExplicit = !!rawSandbox && typeof rawSandbox === 'object' && !Array.isArray(rawSandbox)
        && (rawSandbox as Record<string, unknown>).mode === 'host';
    let toolName = nonEmptyStringOr(input.toolName, DEFAULT_PLUGIN_CONFIG.toolName, warnings, 'toolName');
    if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
        warnings.push(`config.toolName 非法（需匹配 /^[a-z][a-z0-9_]*$/），已回退默认值 ${DEFAULT_PLUGIN_CONFIG.toolName}`);
        toolName = DEFAULT_PLUGIN_CONFIG.toolName;
    }
    const workspacePolicy = input.workspacePolicy === 'allow' || input.workspacePolicy === 'guarded'
        ? input.workspacePolicy
        : (warnings.push(`config.workspacePolicy 只接受 "guarded" 或 "allow"，已回退 guarded`), 'guarded' as const);
    const config: PluginConfig = {
        toolName,
        workspace: nonEmptyStringOr(input.workspace, DEFAULT_PLUGIN_CONFIG.workspace, warnings, 'workspace'),
        workspacePolicy,
        maxRounds: positiveIntOr(input.maxRounds, DEFAULT_PLUGIN_CONFIG.maxRounds, warnings, 'maxRounds'),
        subagentProvider: nonEmptyStringOr(input.subagentProvider, DEFAULT_PLUGIN_CONFIG.subagentProvider, warnings, 'subagentProvider'),
        writerModel: normalizeModelConfig(input.writerModel, warnings, 'writerModel'),
        reviewerModel: normalizeModelConfig(input.reviewerModel, warnings, 'reviewerModel'),
        stateDir: nonEmptyStringOr(input.stateDir, DEFAULT_PLUGIN_CONFIG.stateDir, warnings, 'stateDir'),
        chatTimeoutBaseMs: positiveIntOr(input.chatTimeoutBaseMs, DEFAULT_PLUGIN_CONFIG.chatTimeoutBaseMs, warnings, 'chatTimeoutBaseMs'),
        chatTimeoutPer10kCharsMs: positiveIntOr(input.chatTimeoutPer10kCharsMs, DEFAULT_PLUGIN_CONFIG.chatTimeoutPer10kCharsMs, warnings, 'chatTimeoutPer10kCharsMs'),
        chatTimeoutMaxMs: positiveIntOr(input.chatTimeoutMaxMs, DEFAULT_PLUGIN_CONFIG.chatTimeoutMaxMs, warnings, 'chatTimeoutMaxMs'),
        chatMaxAttempts: positiveIntOr(input.chatMaxAttempts, DEFAULT_PLUGIN_CONFIG.chatMaxAttempts, warnings, 'chatMaxAttempts'),
        writerOutputMaxChars: positiveIntOr(input.writerOutputMaxChars, DEFAULT_PLUGIN_CONFIG.writerOutputMaxChars, warnings, 'writerOutputMaxChars'),
        manifestMaxEntries: positiveIntOr(input.manifestMaxEntries, DEFAULT_PLUGIN_CONFIG.manifestMaxEntries, warnings, 'manifestMaxEntries'),
        allowInheritedPresets: input.allowInheritedPresets === true,
        enforceChildToolIsolation: input.enforceChildToolIsolation !== false,
        sandbox: normalizeSandboxConfig(input.sandbox, warnings, 'config.sandbox'),
    };
    if (config.chatTimeoutMaxMs < config.chatTimeoutBaseMs) {
        warnings.push('config.chatTimeoutMaxMs 小于 chatTimeoutBaseMs，已把 chatTimeoutMaxMs 提升到 base');
        config.chatTimeoutMaxMs = config.chatTimeoutBaseMs;
    }
    if (config.allowInheritedPresets) {
        warnings.push('config.allowInheritedPresets=true：子代理将继承父会话工具，写手可能获得执行通道（DACW 核心安全保证失效）');
    }
    if (!config.enforceChildToolIsolation) {
        warnings.push('config.enforceChildToolIsolation=false：不再强制剥离子代理的宿主全局工具');
    }
    if (sandboxExplicit) {
        warnings.push('config.sandbox.mode="host"：测试将以宿主用户全权限直接执行写手产出的代码（无任何隔离）。'
            + '仅在你显式信任写手输出与工作区内容时使用。');
    }
    return { config, warnings, sandboxExplicit };
}

/** 从子代理 `SubagentResult.output`（ContentBlock[]）提取最终文本；非 text block 忽略。 */
export function extractTextBlocks(output: unknown): string {
    if (!Array.isArray(output)) return '';
    const texts: string[] = [];
    for (const block of output) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text);
    }
    return texts.join('\n').trim();
}

function isAbortLike(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as Record<string, unknown>;
    return record.isAbort === true || record.name === 'AbortError';
}

function abortError(): Error {
    const error = new Error('DACW 调用已取消');
    (error as any).isAbort = true;
    return error;
}

export interface ActivationInput {
    config: PluginConfig;
    role: 'writer' | 'reviewer';
    text: string;
    parent: unknown;
    cwd: string;
    presetId: string | null;
    signal: unknown;
    /** 已解析生效的模型；null 表示继承父会话路由（不传 agentOptions）。 */
    model: { provider: string; model: string; reasoningEffort?: string } | null;
}

/**
 * 构造 `ctx.subagents.startActivation()` 参数（纯函数，供回归自测）。
 * delivery='caller'：结果作为 promise 返回值交付，不向父会话写完成通知。
 */
export function buildActivationSpec(input: ActivationInput) {
    const { config, role, text } = input;
    const request: Record<string, unknown> = {
        prompt: [{ type: 'text', text }],
        parent: input.parent,
    };
    if (typeof input.cwd === 'string' && input.cwd) request.cwd = input.cwd;
    if (typeof input.presetId === 'string' && input.presetId) request.agentPreset = input.presetId;
    if (input.model) {
        request.agentOptions = {
            provider: input.model.provider,
            model: input.model.model,
            ...(input.model.reasoningEffort ? { reasoningEffort: input.model.reasoningEffort } : {}),
        };
    }
    return {
        provider: config.subagentProvider,
        label: `dacw-${role}`,
        request,
        signal: input.signal,
        delivery: 'caller' as const,
    };
}

function presetDefinition(presetId: string, name: string, description: string, order: number, persona: string) {
    return {
        id: presetId,
        name,
        description,
        order,
        plugins: [
            {
                id: 'persona',
                name: '@deepseek-ai/dsh-persona',
                config: { prefix: persona, complete: true, includeRuntimeContext: false },
            },
        ],
    };
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function makeLogger(ctx: any) {
    let sink: any = null;
    try {
        const logger = ctx.logger;
        if (typeof logger === 'function') sink = logger('dacw');
        else if (logger) sink = logger;
    } catch { /* 日志通道不可用时静默降级 */ }
    const write = (level: 'info' | 'warn' | 'error', message: string) => {
        try {
            if (sink && typeof sink[level] === 'function') sink[level](message);
            else if (level !== 'info') console.warn(`[dacw] ${message}`);
        } catch { /* 忽略日志失败 */ }
    };
    return {
        info: (m: string) => write('info', m),
        warn: (m: string) => write('warn', m),
        error: (m: string) => write('error', m),
    };
}

// ================= 模型配置解析（读取 DSH 已配置模型） =================

export interface ResolvedRoleModel {
    /** 传给子代理的 agentOptions；null 表示继承父会话路由（不覆盖）。 */
    agentOptions: { provider: string; model: string; reasoningEffort?: string } | null;
    /** 日志/结果展示用标签，例如 "deepseek-account/deepseek-flash（插件配置）"。 */
    label: string;
    source: 'config' | 'inherit';
}

export type ParsedModelSpec =
    | { mode: 'inherit' }
    | { mode: 'explicit'; provider: string; model: string; reasoningEffort?: string }
    | { mode: 'model-only'; model: string; reasoningEffort?: string }
    | { mode: 'invalid'; reason: string };

/** 解析模型配置取值（纯函数）：null/inherit、"provider/model"、纯模型名、对象形式归一化。 */
export function parseModelSpec(spec: ModelConfigValue): ParsedModelSpec {
    const withEffort = <T extends ParsedModelSpec>(parsed: T, reasoningEffort?: string): T =>
        reasoningEffort ? { ...parsed, reasoningEffort } : parsed;
    if (spec === null) return { mode: 'inherit' };
    if (typeof spec === 'string') {
        const text = spec.trim();
        if (!text || text.toLowerCase() === 'inherit') return { mode: 'inherit' };
        const slash = text.indexOf('/');
        if (slash > 0 && slash < text.length - 1) {
            return { mode: 'explicit', provider: text.slice(0, slash).trim(), model: text.slice(slash + 1).trim() };
        }
        return { mode: 'model-only', model: text };
    }
    const provider = spec.provider && spec.provider.trim() ? spec.provider.trim() : undefined;
    const model = spec.model && spec.model.trim() ? spec.model.trim() : undefined;
    const reasoningEffort = spec.reasoningEffort && spec.reasoningEffort.trim() ? spec.reasoningEffort.trim() : undefined;
    if (provider && model) return withEffort({ mode: 'explicit', provider, model }, reasoningEffort);
    if (model) return withEffort({ mode: 'model-only', model }, reasoningEffort);
    return {
        mode: 'invalid',
        reason: `缺少 model（provider="${provider ?? ''}"）；可写成 "provider/model"、"model"，或 { model, provider? }`,
    };
}

/** 展示标签（纯函数）。 */
export function formatModelLabel(provider: string, model: string, reasoningEffort?: string): string {
    return `${provider}/${model}${reasoningEffort ? `（reasoning=${reasoningEffort}）` : ''}`;
}

/** 继承模式展示标签：尽力带上 DSH 当前默认模型作参考。纯函数。 */
export function formatInheritLabel(dshDefault: { provider?: string; model?: string } | null): string {
    if (dshDefault && typeof dshDefault.provider === 'string' && dshDefault.provider
        && typeof dshDefault.model === 'string' && dshDefault.model) {
        return `继承父会话路由（DSH 默认: ${dshDefault.provider}/${dshDefault.model}）`;
    }
    return '继承父会话路由';
}

export interface ModelCatalogueEntry {
    provider: string;
    models: Array<{ id: string; name?: string }>;
}

/**
 * 按模型名在 DSH 已配置模型目录中找唯一 provider（纯函数）。
 * 先精确匹配模型 id，再匹配显示名；0 个或多个匹配都返回带候选的错误说明。
 */
export function matchModelInCatalogue(
    modelId: string,
    catalogue: ModelCatalogueEntry[],
): { provider: string; matchedBy: 'id' | 'name' } | { error: string } {
    const target = modelId.trim().toLowerCase();
    if (!target) return { error: '模型名为空' };
    const idMatches = catalogue.filter((entry) => entry.models.some((model) => model.id.toLowerCase() === target));
    if (idMatches.length === 1) return { provider: idMatches[0].provider, matchedBy: 'id' };
    if (idMatches.length > 1) {
        return {
            error: `模型 "${modelId}" 在多个 provider 的目录中同名：${idMatches.map((entry) => entry.provider).join(', ')}；请写成 "provider/model"`,
        };
    }
    const nameMatches = catalogue.filter((entry) => entry.models.some((model) => (model.name ?? '').toLowerCase() === target));
    if (nameMatches.length === 1) return { provider: nameMatches[0].provider, matchedBy: 'name' };
    if (nameMatches.length > 1) {
        return {
            error: `模型显示名 "${modelId}" 在多个 provider 的目录中同名：${nameMatches.map((entry) => entry.provider).join(', ')}；请写成 "provider/model"`,
        };
    }
    const known = catalogue.flatMap((entry) => entry.models.map((model) => `${entry.provider}/${model.id}`));
    const sample = known.slice(0, 12).join(', ');
    return {
        error: `在 DSH 已配置模型目录中找不到模型 "${modelId}"`
            + (known.length > 0 ? `（可用示例：${sample}${known.length > 12 ? ' …' : ''}）` : '（目录为空）'),
    };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label)), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

/** 读取 DSH 当前已注册的 provider 路由（llm 服务不可用时返回 null）。 */
function readConfiguredProviders(ctx: any): string[] | null {
    try {
        const llm = ctx.get('llm');
        if (!llm || typeof llm.listProviders !== 'function') return null;
        const list = llm.listProviders();
        if (!Array.isArray(list)) return null;
        return list
            .map((provider: any) => (typeof provider === 'string' ? provider : provider && (provider.id ?? provider.provider)))
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
    } catch {
        return null;
    }
}

/** 读取 DSH 已配置模型目录（provider → 模型列表）；单个 provider 目录读取失败只留空目录。 */
async function readModelCatalogue(
    ctx: any,
    logger: ReturnType<typeof makeLogger>,
    timeoutMs = 2500,
): Promise<ModelCatalogueEntry[]> {
    let llm: any = null;
    try { llm = ctx.get('llm'); } catch { llm = null; }
    const providers = readConfiguredProviders(ctx);
    if (!llm || providers === null) return [];
    const entries: ModelCatalogueEntry[] = [];
    for (const provider of providers) {
        let models: any[] = [];
        if (typeof llm.listModels === 'function') {
            try {
                const list = await withTimeout(Promise.resolve(llm.listModels(provider)), timeoutMs, `读取 ${provider} 模型目录超时`);
                models = Array.isArray(list) ? list : [];
            } catch (error) {
                logger.warn(`DACW: 读取 provider "${provider}" 的模型目录失败（${errorMessage(error)}），按无目录处理`);
            }
        }
        entries.push({
            provider,
            models: models
                .map((model: any) => ({
                    id: typeof model === 'string' ? model : String(model && (model.id ?? model.model ?? '')),
                    name: model && typeof model.name === 'string' ? model.name : undefined,
                }))
                .filter((model) => model.id),
        });
    }
    return entries;
}

/** DSH 当前默认模型选择（继承模式的展示参考）；不可用时返回 null。 */
export function readDshDefaultModel(ctx: any): { provider?: string; model?: string; reasoningEffort?: string } | null {
    try {
        const service = ctx.get('agentDefaultModel');
        if (!service || typeof service.currentSelection !== 'function') return null;
        const selection = service.currentSelection();
        if (!selection || typeof selection !== 'object') return null;
        return {
            provider: typeof selection.provider === 'string' ? selection.provider : undefined,
            model: typeof selection.model === 'string' ? selection.model : undefined,
            reasoningEffort: typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : undefined,
        };
    } catch {
        return null;
    }
}

/**
 * 解析实际生效的写手/审查者模型：
 *   - 未配置/inherit → 不覆盖子代理路由（继承父会话），日志带 DSH 默认模型作参考；
 *   - 显式 provider/model → 校验 provider 在 DSH 已注册路由中（llm 可用时），作为 agentOptions 传递；
 *   - 只给模型名 → 读取 DSH 已配置模型目录解析唯一 provider，失败即 fail-closed 报错。
 */
async function resolveRoleModel(
    ctx: any,
    spec: ModelConfigValue,
    role: 'writer' | 'reviewer',
    logger: ReturnType<typeof makeLogger>,
): Promise<ResolvedRoleModel> {
    const field = role === 'writer' ? 'writerModel' : 'reviewerModel';
    const parsed = parseModelSpec(spec);
    if (parsed.mode === 'inherit') {
        return { agentOptions: null, label: formatInheritLabel(readDshDefaultModel(ctx)), source: 'inherit' };
    }
    if (parsed.mode === 'invalid') {
        throw new Error(`[DACW] config.${field} 非法：${parsed.reason}`);
    }
    if (parsed.mode === 'model-only') {
        logger.info(`DACW: config.${field} 只给了模型名 "${parsed.model}"，正在读取 DSH 已配置模型目录解析 provider…`);
        const catalogue = await readModelCatalogue(ctx, logger);
        if (catalogue.length === 0) {
            throw new Error(
                `[DACW] config.${field} 只给了模型名 "${parsed.model}"，但无法读取 DSH 已配置模型目录`
                + `（llm 服务不可用或没有已注册 provider）；请写成 "provider/model" 形式。`);
        }
        const match = matchModelInCatalogue(parsed.model, catalogue);
        if ('error' in match) throw new Error(`[DACW] config.${field}: ${match.error}`);
        return {
            agentOptions: {
                provider: match.provider,
                model: parsed.model,
                ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
            },
            label: formatModelLabel(match.provider, parsed.model, parsed.reasoningEffort) + '（插件配置）',
            source: 'config',
        };
    }
    const providers = readConfiguredProviders(ctx);
    if (providers && !providers.includes(parsed.provider)) {
        throw new Error(
            `[DACW] config.${field} 的 provider "${parsed.provider}" 未在 DSH 中注册`
            + `（已配置：${providers.length > 0 ? providers.join(', ') : '无'}）；`
            + `请检查 config，或改用纯模型名形式 "model" 让插件从 DSH 目录解析。`);
    }
    return {
        agentOptions: {
            provider: parsed.provider,
            model: parsed.model,
            ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
        },
        label: formatModelLabel(parsed.provider, parsed.model, parsed.reasoningEffort) + '（插件配置）',
        source: 'config',
    };
}

/** 子代理隔离状态：apply 创建，工具执行时校验。 */
interface IsolationState {
    enabled: boolean;
    /** 已成功应用工具隔离的子代理会话 id。 */
    restricted: Set<string>;
    /** childId -> restrict 返回的 disposer（防泄漏，agent/disposed 时释放）。 */
    disposers: Map<string, () => void>;
    /** 成功隔离次数 / 失败次数。 */
    applied: number;
    failures: number;
    lastError: string;
}

/**
 * 把宿主全局工具从 DACW 子代理作用域中全部剥除，并在隔离后校验子代理作用域确实看不到工具。
 * 失败时【抛错】：agent/created 是 serial 监听器，抛错会让本次子代理创建失败（不发布），
 * 避免"已发布但还带着继承工具"的时间窗。
 *
 * fail-closed（E 组）：只有「restrict 成功应用」+「tools.schemas(agent) 返回空数组」两个条件
 * 同时满足才记为成功；验证能力缺失（缺 tools.schemas / 返回非数组 / 调用抛错）一律 fail，
 * 绝不"无法验证但记成功"。enforceChildToolIsolation=false 是唯一逃生门（见 apply()）。
 */
export function restrictChildTools(ctx: any, agent: any, isolation: IsolationState, logger: ReturnType<typeof makeLogger>): void {
    const fail = (reason: string): never => {
        isolation.failures += 1;
        isolation.lastError = reason;
        logger.error(`DACW: 子代理工具隔离失败：${reason}`);
        throw new Error(`[DACW] 子代理工具隔离失败：${reason}`);
    };
    /** 隔离机制已应用、但验证能力缺失：先打诚实的"无法验证"日志，再 fail（不得记为成功）。 */
    const failUnverified = (reason: string): never => {
        logger.error(`DACW: 子代理 ${String(agent && agent.id)} 隔离已应用但无法验证（${reason}）`);
        return fail(reason);
    };
    if (!agent || !agent.ctx || !agent.ctx.tools || typeof agent.ctx.tools.restrict !== 'function') {
        fail('子代理上下文缺少 tools.restrict');
    }
    const childId = String(agent.id);
    let dispose: unknown = null;
    let restrictApplied = false;
    let strategy = '';
    try {
        // 首选 allow: []：完全遮蔽全部工具（含之后才注册的全局工具）。
        dispose = agent.ctx.tools.restrict({ allow: [] });
        restrictApplied = true;
        strategy = 'allow:[]';
    } catch {
        // 只有 allow:[] 失败时才走 deny 快照回退；回退必须能枚举全局工具，否则无法安全回退。
        if (typeof ctx.tools.schemas !== 'function') fail('无法枚举宿主全局工具（ctx.tools.schemas 缺失），无法安全回退');
        let names: string[] = [];
        try {
            names = ctx.tools.schemas()
                .map((schema: any) => schema && schema.name)
                .filter((name: unknown) => typeof name === 'string' && name);
        } catch (error) {
            fail(`读取宿主全局工具列表失败：${errorMessage(error)}`);
        }
        if (names.length === 0) {
            // 空 deny 会被宿主拒绝：没有可应用的隔离机制 => 不可记为成功（fail-closed）。
            fail('宿主全局工具列表为空且 allow:[] 不可用，无法应用工具隔离');
        }
        try {
            dispose = agent.ctx.tools.restrict({ deny: names });
            restrictApplied = true;
            strategy = `deny:${names.join(',')}`;
        } catch (error) {
            fail(`ctx.tools.restrict 执行失败：${errorMessage(error)}`);
        }
    }
    // 生效校验：必须同时满足「restrict 成功应用」+「schemas(agent) 返回空数组」才记为成功。
    if (!restrictApplied) failUnverified('restrict 未成功应用');
    if (typeof agent.ctx.tools.schemas !== 'function') {
        failUnverified('子代理上下文缺少 tools.schemas，无法验证隔离生效');
    }
    let visible: unknown;
    try {
        visible = agent.ctx.tools.schemas(agent);
    } catch (error) {
        failUnverified(`调用 tools.schemas(agent) 失败：${errorMessage(error)}`);
    }
    if (!Array.isArray(visible)) {
        failUnverified('tools.schemas(agent) 未返回工具数组，无法验证隔离生效');
    }
    if (visible.length > 0) {
        const names = visible.map((schema: any) => schema && schema.name).filter(Boolean).join(', ');
        fail(`隔离后子代理仍可见 ${visible.length} 个工具（${names}）`);
    }
    if (typeof dispose === 'function') isolation.disposers.set(childId, dispose as () => void);
    isolation.restricted.add(childId);
    isolation.applied += 1;
    logger.info(`DACW: 子代理 ${childId} 工具隔离已生效（策略 ${strategy}，隔离后可见工具 0 个）`);
}

/** 子代理最终文本 → 协调器需要的字符串；失败时抛出结构化错误（协调器会打回/终止）。 */
export async function runSubagentChat(options: {
    subagents: any;
    config: PluginConfig;
    presets: { ready: boolean; reason?: string };
    isolation: IsolationState;
    agent: unknown;
    workspaceDir: string;
    signal: AbortSignal | undefined;
    role: 'writer' | 'reviewer';
    text: string;
    dacwChildren: Set<string>;
    logger: ReturnType<typeof makeLogger>;
    /** 本角色已解析的模型（null 表示继承父会话路由）。 */
    roleModel: ResolvedRoleModel;
}): Promise<string> {
    const { subagents, config, presets, isolation, agent, workspaceDir, signal, role, text, dacwChildren, logger, roleModel } = options;
    const presetId = presets.ready ? (role === 'writer' ? WRITER_PRESET_ID : REVIEWER_PRESET_ID) : null;
    if (signal && signal.aborted) throw abortError();
    const spec = buildActivationSpec({
        config, role, text, parent: agent, cwd: workspaceDir, presetId, signal,
        model: roleModel.agentOptions,
    });
    let activation: any;
    try {
        activation = await subagents.startActivation(spec);
    } catch (error) {
        if ((signal && signal.aborted) || isAbortLike(error)) throw abortError();
        throw new Error(`[DACW] ${role} 子代理启动失败：${errorMessage(error)}`);
    }
    const childId = activation && activation.childId ? String(activation.childId) : '';
    const disposeActivation = async () => {
        try { if (activation && typeof activation.dispose === 'function') await activation.dispose(); } catch { /* 尽力清理 */ }
    };

    // fail-closed：要求隔离生效的子代理，在启动后必须确认工具已被剥离。
    // E 组验收：enforce=true 时任何「无法确认隔离」的路径都必须终止——
    //   preset 不可用（无法确认运行在零工具 preset 上）、provider 未返回 childId、隔离未生效。
    // 唯一逃生门是显式 enforceChildToolIsolation=false（allowInheritedPresets 不再单独构成旁路）。
    if (config.enforceChildToolIsolation) {
        if (!presets.ready) {
            await disposeActivation();
            throw new Error(
                `[DACW] enforceChildToolIsolation=true 但写手/审查者专用 preset 不可用（${presets.reason || '未知原因'}），`
                + '无法确认子代理运行在零工具 preset 上：拒绝运行。'
                + '请修复 preset 注册，或在明确接受风险后设置 config.enforceChildToolIsolation=false。');
        }
        if (!childId) {
            await disposeActivation();
            throw new Error(
                '[DACW] provider 未返回有效 childId，无法确认隔离生效：'
                + '拒绝在写手/审查者可能继承宿主工具的情况下运行。'
                + '可修复宿主环境，或在明确接受风险后设置 config.enforceChildToolIsolation=false。');
        }
        if (!isolation.restricted.has(childId)) {
            await disposeActivation();
            throw new Error(
                `[DACW] 子代理 ${childId} 的工具隔离未生效（${isolation.lastError || '未知原因'}）：` +
                `拒绝在写手/审查者可能继承宿主工具的情况下运行。可修复宿主环境，或在明确接受风险后设置 config.enforceChildToolIsolation=false。`);
        }
    }
    if (childId) dacwChildren.add(childId);

    let abortListener: (() => void) | null = null;
    const resultPromise = activation && activation.result;
    if (resultPromise && typeof resultPromise.catch === 'function') resultPromise.catch(() => { /* race 会消费；防未处理拒绝 */ });
    const abortPromise = signal
        ? new Promise((_resolve, reject) => {
            abortListener = () => {
                reject(abortError());
                try {
                    if (childId && typeof subagents.interrupt === 'function') {
                        subagents.interrupt(childId, { kind: 'ancestor', agent });
                    }
                } catch { /* interrupt 尽力而为 */ }
            };
            if (signal.aborted) abortListener();
            else signal.addEventListener('abort', abortListener, { once: true });
        })
        : null;
    try {
        const result: any = abortPromise ? await Promise.race([resultPromise, abortPromise]) : await resultPromise;
        const stopReason = result && result.stopReason;
        if (stopReason && stopReason !== 'completed') {
            const diagnostic = result && result.diagnostic ? `；诊断：${result.diagnostic}` : '';
            throw new Error(`[DACW] ${role} 子代理未正常完成（stopReason=${stopReason}${diagnostic}）`);
        }
        const output = extractTextBlocks(result && result.output);
        if (!output) throw new Error(`[DACW] ${role} 子代理返回空文本`);
        return output;
    } catch (error) {
        if ((signal && signal.aborted) || isAbortLike(error)) throw abortError();
        throw error;
    } finally {
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
        try { if (activation && typeof activation.dispose === 'function') await activation.dispose(); } catch { /* 清理失败不影响结果 */ }
        if (childId) dacwChildren.delete(childId);
    }
}

// ================= 工作区准备与安全闸门 =================
const PROTECTED_WORKSPACE_ENTRIES = new Set([WORKSPACE_MARKER, 'node_modules', '.git']);

/**
 * 校验 `.dacw-workspace` 标记内容：必须是本插件写入的 JSON（managedBy 匹配）。
 * 仅凭文件名接受标记会让任何带同名文件的目录通过安全闸门，因此必须校验内容。
 * 兼容 0.1 时代的旧包名 `@local/dacw`，避免重命名后既有工作区失效。纯函数。
 */
export function isValidWorkspaceMarker(content: unknown): boolean {
    if (typeof content !== 'string' || content.trim() === '') return false;
    try {
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const managedBy = (parsed as Record<string, unknown>).managedBy;
        return managedBy === WORKSPACE_MARKER_MANAGED_BY || managedBy === LEGACY_WORKSPACE_MARKER_MANAGED_BY;
    } catch {
        return false;
    }
}

/** child 是否等于 parent 或位于其内部（路径均已解析；Windows 大小写不敏感由 path.relative 处理）。 */
function isSameOrInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 必须拒绝的危险目录：文件系统根、用户主目录及其祖先、DSH_HOME / profile 目录。 */
function forbiddenDirectoryReason(directory: string): string | null {
    const parsed = path.parse(directory);
    if (directory === parsed.root) return '文件系统根目录';
    const home = os.homedir();
    if (home && (isSameOrInside(directory, home) || isSameOrInside(home, directory))) {
        // directory 是 home 或 home 的祖先（前者会被本分支再次命中）
        if (directory === home) return '用户主目录';
        if (isSameOrInside(directory, home)) return '用户主目录的祖先目录';
    }
    for (const [label, envName] of [['DSH_HOME', 'DSH_HOME'], ['DSH profile 目录', 'DSH_PROFILE_DIR']] as const) {
        const value = process.env[envName];
        if (!value) continue;
        if (isSameOrInside(directory, value) || isSameOrInside(value, directory)) return label;
    }
    return null;
}

/**
 * 解析并准备 DACW 工作区：
 *   - 拒绝文件系统根、用户主目录及其祖先、DSH_HOME/profile 目录及其祖先（safeCleanWorkspace 会清空非地基文件）；
 *   - guarded 策略要求「空目录（忽略 node_modules/.git）」或「带合法 .dacw-workspace 标记」；
 *   - 创建目录与标记文件；标记经过内容校验，避免凭文件名绕过。
 */
export async function prepareWorkspace(baseDir: string, requested: string, policy: 'guarded' | 'allow') {
    const lexical = path.resolve(baseDir, requested && requested.trim() ? requested : '.');
    const lexicalReason = forbiddenDirectoryReason(lexical);
    if (lexicalReason) throw new Error(`[DACW 安全拦截] 拒绝把${lexicalReason}作为工作区：${lexical}`);
    await fs.mkdir(lexical, { recursive: true });
    // 真实路径复检：防符号链接把危险目录伪装成普通新目录。
    const directory = await fs.realpath(lexical);
    const realReason = forbiddenDirectoryReason(directory);
    if (realReason) throw new Error(`[DACW 安全拦截] 拒绝把${realReason}作为工作区：${directory}（realpath）`);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const markerEntry = entries.find((entry) => entry.name === WORKSPACE_MARKER);
    let hasMarker = false;
    const markerPath = path.join(directory, WORKSPACE_MARKER);
    if (markerEntry) {
        if (!markerEntry.isFile()) {
            throw new Error(`[DACW 安全拦截] 工作区的 ${WORKSPACE_MARKER} 不是普通文件：${directory}`);
        }
        const content = await fs.readFile(markerPath, 'utf-8').catch(() => '');
        if (!isValidWorkspaceMarker(content)) {
            throw new Error(
                `[DACW 安全拦截] 工作区存在 ${WORKSPACE_MARKER}，但不是本插件写入的标记（managedBy 不匹配）：${directory}。` +
                `为避免误删该目录中的文件，DACW 拒绝运行；请换一个新目录，或确认后手动删除该标记文件。`);
        }
        hasMarker = true;
    }
    if (policy === 'guarded' && !hasMarker) {
        const foreign = entries.filter((entry) => !PROTECTED_WORKSPACE_ENTRIES.has(entry.name));
        if (foreign.length > 0) {
            throw new Error(
                `[DACW 安全拦截] 工作区不是空目录，也没有合法的 ${WORKSPACE_MARKER} 标记：${directory}。` +
                `DACW 每轮会把工作区内容重置为产出文件集（仅保留 package.json 等地基文件与 .git/node_modules），` +
                `为避免误删，请指向新的空目录，或显式把 config.workspacePolicy 设为 "allow"。`);
        }
    }
    if (!hasMarker) await fs.writeFile(markerPath, WORKSPACE_MARKER_CONTENT, 'utf-8');
    return directory;
}

function tailLogs(logs: string[], maxLines: number, maxChars: number): string[] {
    const lines = logs.length > maxLines ? logs.slice(logs.length - maxLines) : logs.slice();
    let total = 0;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (total + line.length > maxChars && kept.length > 0) break;
        kept.unshift(line);
        total += line.length;
    }
    if (kept.length < logs.length) kept.unshift(`...（已省略前 ${logs.length - kept.length} 行日志）`);
    return kept;
}

function renderToolResultText(value: any): string {
    const lines: string[] = [];
    lines.push(`DACW 结果：${value.success ? '机器闸门通过' : '未通过'}`);
    lines.push(`状态：${value.status}${value.status === 'NEED_HUMAN' ? '（需要人工终审，未经确认不要合入）' : ''}`);
    lines.push(`工作区：${value.workspace}`);
    if (value.models && typeof value.models.writer === 'string' && typeof value.models.reviewer === 'string') {
        lines.push(`模型：✍️ 写手 ${value.models.writer} | 🔍 审查者 ${value.models.reviewer}`);
    }
    if (typeof value.round === 'number' && value.round > 0) lines.push(`轮次：${value.round}`);
    if (Array.isArray(value.files) && value.files.length > 0) {
        lines.push(`文件（${value.files.length}）：`);
        for (const file of value.files.slice(0, 200)) lines.push(`  - ${file}`);
        if (value.files.length > 200) lines.push(`  ...（其余 ${value.files.length - 200} 个文件略）`);
    }
    lines.push('');
    lines.push(`说明：${value.message}`);
    if (Array.isArray(value.logs) && value.logs.length > 0) {
        lines.push('');
        lines.push('运行日志（尾部）：');
        for (const line of value.logs) lines.push(`  ${line}`);
    }
    return lines.join('\n');
}

const TOOL_DESCRIPTION =
    '运行 DACW（防御性智能体编程工作流）闭环：写手子代理按增量协议产出代码变更 → 确定性运行机执行项目自带测试 → ' +
    '独立审查者子代理审计全量文件并给出 JSON 裁决 → 通过后停在人工闸门（NEED_HUMAN），绝不自动合入。' +
    '测试在任何审查之前执行；默认在宿主直接执行（无隔离）：测试以宿主用户权限运行写手产出代码；' +
    '设置 sandbox.mode:"docker" 或 "auto" 可启用一次性容器（sandbox 分支）。审查者审计是侦探性控制，不是执行前屏障。' +
    '当需要"让模型写代码、让真实测试验证、让独立审查者把关、最后人工确认"时使用本工具。' +
    '注意：DACW 每轮都会把工作区内容重置为产出文件集（仅保留 package.json 等地基文件与 .git/node_modules），' +
    '因此必须指向专用空目录（工具会写入 .dacw-workspace 标记）；不要在存放重要文件的目录上运行。' +
    '模型调用发生在独立子代理会话里，不污染当前会话；子代理在创建时被剥除全部宿主工具。' +
    '写手/审查者可分别配置模型：支持 "provider/model"、纯 "model"（按 DSH 已配置模型目录自动解析 provider）或 inherit；' +
    '运行日志首行与结果 models 字段显示实际生效的写手/审查者模型。';

export function apply(ctx: any, rawConfig?: unknown) {
    const { config, warnings, sandboxExplicit } = normalizePluginConfig(rawConfig);
    const logger = makeLogger(ctx);
    for (const warning of warnings) logger.warn(`DACW: ${warning}`);

    // ---- 子代理 preset 注册（persona-only；工具隔离由 agent/created 监听器完成）----
    const presets: { ready: boolean; reason: string; disposers: Array<() => Promise<void> | void> } = {
        ready: false,
        reason: '尚未注册',
        disposers: [],
    };
    const agentPresets: any = (() => { try { return ctx.get('agentPresets'); } catch { return undefined; } })();
    if (agentPresets && typeof agentPresets.register === 'function') {
        ctx.effect(() => {
            let disposed = false;
            void (async () => {
                try {
                    const definitions = [
                        presetDefinition(WRITER_PRESET_ID, 'DACW Writer', 'DACW 写手子代理：只输出增量 JSON 变更集，创建时剥除全部宿主工具。', 91, WRITER_PERSONA),
                        presetDefinition(REVIEWER_PRESET_ID, 'DACW Reviewer', 'DACW 审查者子代理：只输出 JSON 裁决，创建时剥除全部宿主工具。', 92, REVIEWER_PERSONA),
                    ];
                    for (const definition of definitions) {
                        const dispose = await agentPresets.register(definition);
                        if (disposed) {
                            try { await dispose(); } catch { /* 已丢弃 */ }
                            continue;
                        }
                        if (typeof dispose === 'function') presets.disposers.push(dispose);
                        if (typeof agentPresets.resolve === 'function') {
                            const detail = await agentPresets.resolve(definition.id).catch(() => null);
                            if (detail && typeof detail.broken === 'string' && detail.broken) {
                                throw new Error(`${definition.id} 激活失败：${detail.broken}`);
                            }
                        }
                    }
                    presets.ready = true;
                    presets.reason = '';
                    logger.info('DACW: 写手/审查者子代理 preset 已注册');
                } catch (error) {
                    presets.ready = false;
                    presets.reason = errorMessage(error);
                    logger.error(`DACW: 子代理 preset 注册失败：${presets.reason}`);
                }
            })();
            return () => {
                disposed = true;
                for (const dispose of presets.disposers.splice(0)) {
                    try { void Promise.resolve(dispose()).catch(() => { /* 忽略 */ }); } catch { /* 忽略 */ }
                }
            };
        });
    } else {
        presets.reason = '宿主未提供 agentPresets 服务';
        logger.warn('DACW: 宿主未提供 agentPresets 服务，无法注册写手/审查者 preset');
    }

    // ---- 子代理工具隔离（agent/created / agent/disposed）----
    const isolation: IsolationState = {
        enabled: config.enforceChildToolIsolation,
        restricted: new Set(),
        disposers: new Map(),
        applied: 0,
        failures: 0,
        lastError: '',
    };
    const composedPresetOf = (agent: any): string | undefined => {
        try {
            if (agentPresets && typeof agentPresets.composedPreset === 'function' && agent && agent.ctx) {
                return agentPresets.composedPreset(agent.ctx);
            }
        } catch { /* 视为未知 */ }
        return undefined;
    };
    const isDacwPreset = (preset: string | undefined): boolean =>
        preset === WRITER_PRESET_ID || preset === REVIEWER_PRESET_ID;

    if (config.enforceChildToolIsolation) {
        ctx.effect(() => ctx.on('agent/created', (payload: any) => {
            const agent = payload && payload.agent ? payload.agent : null;
            if (!agent) return;
            if (!isDacwPreset(composedPresetOf(agent))) return;
            restrictChildTools(ctx, agent, isolation, logger);
        }));
        ctx.effect(() => ctx.on('agent/disposed', (payload: any) => {
            const agent = payload && payload.agent ? payload.agent : null;
            if (!agent) return;
            const childId = String(agent.id);
            const dispose = isolation.disposers.get(childId);
            if (dispose) {
                try { dispose(); } catch { /* 忽略 */ }
                isolation.disposers.delete(childId);
            }
            isolation.restricted.delete(childId);
        }));
    }

    // ---- 工具注册 ----
    const dacwChildren = new Set<string>();
    const isDacwChild = (agent: any): boolean => {
        if (!agent) return false;
        const id = String(agent.id ?? '');
        if (id && (dacwChildren.has(id) || isolation.restricted.has(id))) return true;
        return isDacwPreset(composedPresetOf(agent));
    };
    const callerWorkingDirectory = async (agent: any, signal: AbortSignal | undefined): Promise<string> => {
        const workingDirectory: any = (() => { try { return ctx.get('workingDirectory'); } catch { return undefined; } })();
        if (workingDirectory && typeof workingDirectory.ensure === 'function') {
            try {
                const directory = await workingDirectory.ensure(agent, signal);
                if (typeof directory === 'string' && directory) return directory;
            } catch { /* 回退到进程目录 */ }
        }
        return process.cwd();
    };

    const toolDefinition = {
        name: config.toolName,
        description: TOOL_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                task: { type: 'string', description: '要实现/修改的需求描述（自然语言，越具体越好）。' },
                workspace: { type: 'string', description: 'DACW 专用工作区目录；绝对路径，或相对当前会话工作目录。省略则用配置的 workspace，再退回当前会话工作目录。' },
                task_id: { type: 'string', description: '可选任务 ID，用于状态/审计记录文件名；省略则自动生成。' },
            },
            required: ['task'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    status: { type: 'string' },
                    message: { type: 'string' },
                    workspace: { type: 'string' },
                    models: {
                        type: 'object',
                        properties: {
                            writer: { type: 'string' },
                            reviewer: { type: 'string' },
                        },
                        required: ['writer', 'reviewer'],
                        additionalProperties: false,
                    },
                    round: { type: 'integer' },
                    files: { type: 'array', items: { type: 'string' } },
                    logs: { type: 'array', items: { type: 'string' } },
                    elapsed_ms: { type: 'integer' },
                },
                required: ['success', 'status', 'message', 'workspace', 'models', 'round', 'files', 'logs', 'elapsed_ms'],
                additionalProperties: false,
            },
            render: (_args: unknown, value: any) => [{ type: 'text', text: renderToolResultText(value) }],
        },
        async execute(rawArgs: unknown, exec: any) {
            const startedAt = Date.now();
            const args = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {};
            const task = typeof args.task === 'string' ? args.task.trim() : '';
            if (!task) throw new Error('[DACW] 参数 task 必须是非空字符串');
            if (task.length > MAX_TASK_CHARS) throw new Error(`[DACW] 参数 task 过长（${task.length} > ${MAX_TASK_CHARS} 字符）`);
            const taskIdArg = typeof args.task_id === 'string' ? args.task_id.trim() : '';
            if (taskIdArg.length > MAX_TASK_ID_CHARS) throw new Error(`[DACW] 参数 task_id 过长（${taskIdArg.length} > ${MAX_TASK_ID_CHARS} 字符）`);
            const workspaceArg = typeof args.workspace === 'string' ? args.workspace.trim() : '';
            if (workspaceArg.length > MAX_WORKSPACE_ARG_CHARS) throw new Error(`[DACW] 参数 workspace 过长（${workspaceArg.length} > ${MAX_WORKSPACE_ARG_CHARS} 字符）`);
            const subagents: any = (() => { try { return ctx.get('subagents'); } catch { return undefined; } })();
            if (!subagents) throw new Error('[DACW] 宿主缺少 subagents 服务：DACW 需要它创建写手/审查者子代理');
            const providerName = config.subagentProvider;
            const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined;
            if (!provider) {
                const available = typeof subagents.list === 'function' ? subagents.list().join(', ') : '未知';
                throw new Error(`[DACW] 子代理 provider "${providerName}" 未注册（可用：${available}）`);
            }
            if (presets.ready && provider.capabilities && provider.capabilities.agentPreset === false) {
                throw new Error(
                    `[DACW] 子代理 provider "${providerName}" 不支持 agentPreset（独立 preset 子代理），` +
                    `无法保证写手/审查者运行在专用零工具 preset 上；请改用 spawn（@deepseek-ai/dsh-subagent-spawn-in-process），` +
                    `或在明确接受风险后同时设置 config.allowInheritedPresets: true 与 config.enforceChildToolIsolation: false。`);
            }
            const agent = exec && exec.agent ? exec.agent : null;
            if (!agent) throw new Error('[DACW] 只能由 Agent 调用：执行上下文缺少调用方 Agent');
            if (isDacwChild(agent)) throw new Error('[DACW] 禁止在 DACW 写手/审查者子代理内再次运行 dacw_run（防递归）');
            if (!presets.ready && !config.allowInheritedPresets) {
                throw new Error(
                    `[DACW] 写手/审查者专用 preset 不可用（${presets.reason}），拒绝让子代理继承父会话工具运行。` +
                    `请修复 preset 注册（需要 @deepseek-ai/dsh-persona 与 agentPresets 服务），` +
                    `或在明确接受风险后设置 config.allowInheritedPresets: true 与 config.enforceChildToolIsolation: false。`);
            }

            // 解析写手/审查者实际模型：读取 DSH 已配置模型目录 / 默认模型；配置错误在启动工作流前 fail-closed。
            const roleModels: { writer: ResolvedRoleModel; reviewer: ResolvedRoleModel } = {
                writer: await resolveRoleModel(ctx, config.writerModel, 'writer', logger),
                reviewer: await resolveRoleModel(ctx, config.reviewerModel, 'reviewer', logger),
            };
            const roleModelLabels = { writer: roleModels.writer.label, reviewer: roleModels.reviewer.label };

            const signal: AbortSignal | undefined = exec && exec.signal ? exec.signal : undefined;
            const baseDir = await callerWorkingDirectory(agent, signal);
            const requested = workspaceArg || config.workspace;
            const workspaceDir = await prepareWorkspace(baseDir, requested, config.workspacePolicy);

            const logs: string[] = [];
            const log = (message: string) => {
                logs.push(message);
                logger.info(message);
            };
            const engineContext = {
                async chat(agentId: string, prompt: string, contextStr: string) {
                    const role: 'writer' | 'reviewer' = agentId === 'reviewer-agent' ? 'reviewer' : 'writer';
                    const text = contextStr && contextStr.trim() ? `${prompt}\n\n${contextStr}` : prompt;
                    return runSubagentChat({
                        subagents, config, presets, isolation, agent, workspaceDir, signal,
                        role, text, dacwChildren, logger,
                        roleModel: role === 'writer' ? roleModels.writer : roleModels.reviewer,
                    });
                },
                log,
            };
            const executeTask = createEngine(engineContext, {
                maxRounds: config.maxRounds,
                chatTimeoutBaseMs: config.chatTimeoutBaseMs,
                chatTimeoutPer10kCharsMs: config.chatTimeoutPer10kCharsMs,
                chatTimeoutMaxMs: config.chatTimeoutMaxMs,
                chatMaxAttempts: config.chatMaxAttempts,
                writerOutputMaxChars: config.writerOutputMaxChars,
                manifestMaxEntries: config.manifestMaxEntries,
                stateDir: config.stateDir || null,
                roleModels: roleModelLabels,
                sandbox: config.sandbox,
                sandboxExplicit,
            });
            const rawTaskId = taskIdArg || `dacw-${Date.now().toString(36)}`;
            const result = await executeTask(rawTaskId, workspaceDir, task);
            const value = {
                success: result.success === true,
                status: String(result.status),
                message: String(result.message),
                workspace: workspaceDir,
                models: roleModelLabels,
                round: typeof result.round === 'number' ? result.round : 0,
                files: Array.isArray(result.files) ? result.files.map(String) : [],
                logs: tailLogs(logs, 60, 8000),
                elapsed_ms: Date.now() - startedAt,
            };
            if (!value.success) {
                const failure = new Error(
                    `[DACW] 工作流未通过（status=${value.status}，round=${value.round}）：${value.message}\n` +
                    `工作区：${value.workspace}\n\n${renderToolResultText(value)}`);
                (failure as any).dacw = value;
                throw failure;
            }
            return value;
        },
    };

    ctx.effect(() => ctx.tools.register(toolDefinition));
    logger.info(
        `DACW: 工具 ${config.toolName} 已注册（workspacePolicy=${config.workspacePolicy}, sandbox=${config.sandbox.mode}, ` +
        `provider=${config.subagentProvider}, enforceChildToolIsolation=${config.enforceChildToolIsolation}）`);
}
