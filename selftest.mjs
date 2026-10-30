// DACW 纯函数回归自测。
//
// 运行：node build.mjs && node selftest.mjs
// 原理：直接加载构建产物 dist/（插件运行时真正加载的代码），对导出的纯函数跑回归向量。
//      不执行工作流、不写文件系统、不调用任何模型。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const engine = await import('./dist/index.js');
const plugin = await import('./dist/plugin.js');
const sandbox = await import('./dist/sandbox.js');
const runnerModule = await import('./dist/runner.js');

const {
    parseWriterDelta, parseReviewVerdict, mergeDelta, resolveEngineOptions, DEFAULT_ENGINE_OPTIONS,
    enumerateWorkspace, diffDigest, fingerprintProtectedDirs,
} = engine;
const {
    normalizePluginConfig, extractTextBlocks, buildActivationSpec, isValidWorkspaceMarker, prepareWorkspace,
    parseModelSpec, matchModelInCatalogue, formatModelLabel, formatInheritLabel, DEFAULT_PLUGIN_CONFIG,
    restrictChildTools, runSubagentChat,
} = plugin;
const {
    normalizeSandboxConfig, buildDockerRunArgv, defaultImageForCommand, describePolicy, DEFAULT_SANDBOX_CONFIG,
    buildSandboxConsentRequest, parseSandboxConsentAnswer,
} = sandbox;
const { Runner } = runnerModule;

let pass = 0;
let fail = 0;

function t(name, fn) {
    try {
        fn();
        pass += 1;
        console.log(`PASS ${name}`);
    } catch (error) {
        fail += 1;
        console.log(`FAIL ${name}\n  ${error && error.message ? error.message : error}`);
    }
}

/** 断言返回值与期望值深度相等（JSON 语义）。 */
function eq(actual, expected, message = '') {
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
}

function throws(fn, hint = '') {
    let result;
    try { result = fn(); } catch { return; }
    assert.fail(`expected throw, got ${JSON.stringify(result)}${hint ? ` (${hint})` : ''}`);
}

const WS = 'E:\\virtual-ws';   // 仅做词法校验，不触 fs

// ================= parseWriterDelta：输出协议 v2 =================
t('v2 增量 + 空文件合法', () => eq(
    parseWriterDelta('{"changed":[{"file":"a.py","code":""}],"deleted":["old.js"]}'),
    { changed: [{ file: 'a.py', code: '' }], deleted: ['old.js'], legacyFull: false }));

t('旧版全量数组兼容', () => eq(
    parseWriterDelta('[{"file":"a.py","code":"x"}]'),
    { changed: [{ file: 'a.py', code: 'x' }], deleted: [], legacyFull: true }));

t('旧版单对象兼容', () => eq(
    parseWriterDelta('{"file":"a.py","code":"x"}'),
    { changed: [{ file: 'a.py', code: 'x' }], deleted: [], legacyFull: true }));

t('fence 包裹的 v2 输出', () => eq(
    parseWriterDelta('```json\n{"changed":[{"file":"b.py","code":"y"}],"deleted":[]}\n```'),
    { changed: [{ file: 'b.py', code: 'y' }], deleted: [], legacyFull: false }));

t('纯垃圾输出必须抛错', () => throws(() => parseWriterDelta('REJECTED nonsense, no json here')));
t('changed 项缺 code 必须抛错', () => throws(() => parseWriterDelta('{"changed":[{"file":"a.py"}]}')));
t('changed 项 file 为空必须抛错', () => throws(() => parseWriterDelta('{"changed":[{"file":"","code":"x"}]}')));
t('deleted 项非字符串必须抛错', () => throws(() => parseWriterDelta('{"changed":[],"deleted":[42]}')));
t('超出注入上限必须抛错（含空 code）', () => throws(() => parseWriterDelta('{"changed":[{"file":"a.py","code":"12345"}],"deleted":[]}', 10)));

// ================= mergeDelta：真实合并语义 =================
t('增量：未提及的基线文件逐字节保留', () => {
    const base = new Map([['a.py', 'v1'], ['b.py', 'v1']]);
    const delta = parseWriterDelta('{"changed":[{"file":"a.py","code":"v2"}],"deleted":[]}');
    return eq(Object.fromEntries(mergeDelta(base, delta, WS)), { 'a.py': 'v2', 'b.py': 'v1' });
});

t('全量旧版模式：以输出替换整个基线（未提及的基线文件被删除）', () => {
    const base = new Map([['a.py', 'v1'], ['b.py', 'v1']]);
    const delta = parseWriterDelta('[{"file":"a.py","code":"v2"}]');
    return eq(Object.fromEntries(mergeDelta(base, delta, WS)), { 'a.py': 'v2' });
});

t('空 code 文件在合并后保留（空 __init__.py 合法）', () => {
    const delta = parseWriterDelta('{"changed":[{"file":"__init__.py","code":""}],"deleted":[]}');
    return eq(Object.fromEntries(mergeDelta(new Map(), delta, WS)), { '__init__.py': '' });
});

t('删除受保护地基文件必须拦截（package.json）', () => throws(() => {
    mergeDelta(new Map([['package.json', '{}']]), parseWriterDelta('{"changed":[],"deleted":["package.json"]}'), WS);
}));
t('删除受保护地基文件必须拦截（Cargo.lock）', () => throws(() => {
    mergeDelta(new Map(), parseWriterDelta('{"changed":[],"deleted":["Cargo.lock"]}'), WS);
}));
t('删除高危目录成员必须拦截（.git/config）', () => throws(() => {
    mergeDelta(new Map(), parseWriterDelta('{"changed":[],"deleted":[".git/config"]}'), WS);
}));
t('删除高危目录成员必须拦截（node_modules/x/y.js）', () => throws(() => {
    mergeDelta(new Map(), parseWriterDelta('{"changed":[],"deleted":["node_modules/x/y.js"]}'), WS);
}));
t('changed 路径越权（../）必须拦截', () => throws(() => {
    mergeDelta(new Map(), parseWriterDelta('{"changed":[{"file":"../evil.py","code":"x"}],"deleted":[]}'), WS);
}));
t('deleted 路径越权（../）必须拦截', () => throws(() => {
    mergeDelta(new Map(), parseWriterDelta('{"changed":[],"deleted":["../evil.js"]}'), WS);
}));
t('合并后文件集为空必须抛错', () => throws(() => {
    mergeDelta(new Map([['a.py', 'v1']]), parseWriterDelta('{"changed":[],"deleted":["a.py"]}'), WS);
}));

// ================= 测试后对账：差异摘要（安全不变量 6） =================
t('diffDigest：+ / - / ~ 三类差异，路径稳定排序且带原因', () => {
    const base = new Map([['a.js', 'h1'], ['b.js', 'h2'], ['gone.js', 'h3']]);
    const post = new Map([['a.js', 'h1'], ['b.js', 'CHANGED'], ['new.js', 'h4']]);
    eq(diffDigest(base, post), [
        '~ 内容变更：b.js（测试后内容与基线/快照不一致）',
        '- 删除：gone.js（基线/快照中存在，测试后消失）',
        '+ 新增：new.js（测试后出现，基线/快照中不存在）',
    ]);
});
t('diffDigest：无差异返回空数组', () => {
    eq(diffDigest(new Map([['a.js', 'h1']]), new Map([['a.js', 'h1']])), []);
});

// ================= parseReviewVerdict：裁决回归 =================
t('verdict PASS', () => eq(parseReviewVerdict('{"verdict":"PASS"}'), { verdict: 'PASS', reasons: [] }));
t('verdict REJECTED', () => eq(
    parseReviewVerdict('{"verdict":"REJECTED","reasons":["x"]}'),
    { verdict: 'REJECTED', reasons: ['x'] }));
t('自然语言拒绝 → null', () => eq(parseReviewVerdict('REJECTED: the code does not pass review'), null));
t('小写 pass → null', () => eq(parseReviewVerdict('{"verdict":"pass"}'), null));
t('双对象 → null', () => eq(parseReviewVerdict('{"verdict":"PASS"} {"verdict":"REJECTED"}'), null));
t('空串 → null', () => eq(parseReviewVerdict(''), null));

// ================= resolveEngineOptions：配置注入 =================
t('引擎配置：缺省用默认值', () => eq(resolveEngineOptions(null), DEFAULT_ENGINE_OPTIONS));
t('引擎配置：非法数值回退默认', () => {
    const resolved = resolveEngineOptions({ maxRounds: -1, chatMaxAttempts: 'x', stateDir: '' });
    return eq(resolved, DEFAULT_ENGINE_OPTIONS);
});
t('引擎配置：合法覆盖生效', () => {
    const resolved = resolveEngineOptions({ maxRounds: 2, chatTimeoutBaseMs: 1000, stateDir: 'C:\\tmp' });
    assert.equal(resolved.maxRounds, 2);
    assert.equal(resolved.chatTimeoutBaseMs, 1000);
    assert.equal(resolved.stateDir, 'C:\\tmp');
    assert.equal(resolved.chatMaxAttempts, DEFAULT_ENGINE_OPTIONS.chatMaxAttempts);
});

// ================= normalizePluginConfig：Host 配置 =================
t('插件配置：缺省用默认值', () => eq(normalizePluginConfig(undefined).config, DEFAULT_PLUGIN_CONFIG));
t('插件配置：非法字段回退并告警', () => {
    const { config, warnings } = normalizePluginConfig({
        toolName: 'Bad Name', workspacePolicy: 'whatever', maxRounds: 0, writerModel: { provider: 'p' },
    });
    assert.equal(config.toolName, DEFAULT_PLUGIN_CONFIG.toolName);
    assert.equal(config.workspacePolicy, 'guarded');
    assert.equal(config.maxRounds, DEFAULT_PLUGIN_CONFIG.maxRounds);
    // provider-only 保留（运行时 fail-closed 报错），并在 apply 时告警
    eq(config.writerModel, { provider: 'p' });
    assert.equal(warnings.length, 4);
});
t('插件配置：合法值生效 + 超时上限抬升', () => {
    const { config } = normalizePluginConfig({
        toolName: 'dacw2', workspacePolicy: 'allow', maxRounds: 5, subagentProvider: 'fork',
        writerModel: { provider: 'deepseek', model: 'deepseek-chat' },
        chatTimeoutBaseMs: 5000, chatTimeoutMaxMs: 1000,
    });
    assert.equal(config.toolName, 'dacw2');
    assert.equal(config.workspacePolicy, 'allow');
    assert.equal(config.maxRounds, 5);
    assert.equal(config.subagentProvider, 'fork');
    eq(config.writerModel, { provider: 'deepseek', model: 'deepseek-chat' });
    assert.equal(config.chatTimeoutMaxMs, 5000);
});
t('插件配置：allowInheritedPresets 只接受严格 true', () => {
    assert.equal(normalizePluginConfig({ allowInheritedPresets: 'yes' }).config.allowInheritedPresets, false);
    assert.equal(normalizePluginConfig({ allowInheritedPresets: true }).config.allowInheritedPresets, true);
});
t('插件配置：工具隔离默认开启，仅显式 false 关闭', () => {
    assert.equal(DEFAULT_PLUGIN_CONFIG.enforceChildToolIsolation, true);
    assert.equal(normalizePluginConfig({}).config.enforceChildToolIsolation, true);
    assert.equal(normalizePluginConfig({ enforceChildToolIsolation: false }).config.enforceChildToolIsolation, false);
    assert.equal(normalizePluginConfig({ enforceChildToolIsolation: 0 }).config.enforceChildToolIsolation, true);
});

// ================= 沙箱策略：测试执行位置（安全边界核心） =================
t('沙箱配置：缺省用默认值（auto，沙盒开启）', () => {
    eq(normalizeSandboxConfig(null, [], 'x'), DEFAULT_SANDBOX_CONFIG);
    assert.equal(DEFAULT_SANDBOX_CONFIG.mode, 'auto');
});
t('沙箱配置：非法 mode / 数值回退并逐项告警', () => {
    const warnings = [];
    const config = normalizeSandboxConfig(
        { mode: 'vm', memoryMb: -1, cpus: 0, pidsLimit: 'x', tmpfsMb: 0 }, warnings, 'config.sandbox');
    eq(config, DEFAULT_SANDBOX_CONFIG);
    assert.equal(warnings.length, 5);
    assert.match(warnings[0], /config\.sandbox\.mode/);
    assert.match(warnings[1], /memoryMb/);
});
t('沙箱配置：合法覆盖生效（cpus 允许小数、image 去空白）', () => {
    eq(normalizeSandboxConfig(
        { mode: 'host', image: ' node:22 ', memoryMb: 512, cpus: 1.5, pidsLimit: 64, tmpfsMb: 32 }, [], 'x'),
        { mode: 'host', image: 'node:22', memoryMb: 512, cpus: 1.5, pidsLimit: 64, tmpfsMb: 32 });
});
t('默认镜像：按测试命令族选择', () => {
    eq(defaultImageForCommand('npm'), 'node:22-bookworm-slim');
    eq(defaultImageForCommand('node'), 'node:22-bookworm-slim');
    eq(defaultImageForCommand('pytest'), 'python:3.12-slim');
    eq(defaultImageForCommand('python3'), 'python:3.12-slim');
    eq(defaultImageForCommand('cargo'), 'rust:1-slim');
    eq(defaultImageForCommand('go'), 'golang:1.23-bookworm');
});
t('docker 参数：隔离与资源限制开关齐全，工作区以一次性暂存目录挂载', () => {
    const argv = buildDockerRunArgv(
        { image: 'node:22-bookworm-slim', memoryMb: 512, cpus: 1.5, pidsLimit: 64, tmpfsMb: 32 },
        '/tmp/dacw-sandbox-xyz', 'dacw-testname', 'npm', ['run', 'test']);
    for (const [flag, value] of [
        ['--network', 'none'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'],
        ['--user', '1000:1000'], ['--pids-limit', '64'], ['--cpus', '1.5'],
        ['--memory', '512m'], ['--memory-swap', '512m'], ['--tmpfs', '/tmp:rw,nosuid,size=32m'],
        ['--name', 'dacw-testname'], ['--workdir', '/dacw'],
    ]) {
        const i = argv.indexOf(flag);
        assert.ok(i >= 0, `缺少 ${flag}`);
        assert.equal(argv[i + 1], value, `${flag} 的值不对：${argv[i + 1]}`);
    }
    assert.ok(argv.includes('--read-only'), '缺少 --read-only');
    assert.ok(argv.includes('--rm'), '缺少 --rm');
    assert.ok(argv.includes('/tmp/dacw-sandbox-xyz:/dacw'), '暂存目录挂载缺失');
    assert.deepEqual(argv.slice(argv.indexOf('node:22-bookworm-slim') + 1), ['npm', 'run', 'test'], '容器内命令/参数透传不对');
});
t('策略描述：三种策略均给出诚实标注', () => {
    assert.match(describePolicy({ kind: 'blocked', reason: 'no docker' }), /拒绝执行/);
    assert.match(describePolicy({ kind: 'host' }), /无隔离/);
    assert.match(describePolicy({ kind: 'docker', image: 'x', memoryMb: 1, cpus: 1, pidsLimit: 1, tmpfsMb: 1 }), /无网络/);
});
t('引擎配置：sandbox 默认注入且可局部覆盖', () => {
    eq(resolveEngineOptions(null).sandbox, DEFAULT_SANDBOX_CONFIG);
    const resolved = resolveEngineOptions({ sandbox: { mode: 'host' } });
    assert.equal(resolved.sandbox.mode, 'host');
    assert.equal(resolved.sandbox.memoryMb, DEFAULT_SANDBOX_CONFIG.memoryMb);
});
t('引擎配置：sandboxExplicit 默认 false，仅显式 true 生效', () => {
    assert.equal(resolveEngineOptions(null).sandboxExplicit, false);
    assert.equal(resolveEngineOptions({ sandboxExplicit: true }).sandboxExplicit, true);
    assert.equal(resolveEngineOptions({ sandboxExplicit: 'yes' }).sandboxExplicit, false);
});
t('沙盒确认：请求文案（检测内容输出）与回答解析（只有选关闭才 disable）', () => {
    const request = buildSandboxConsentRequest({ kind: 'blocked', reason: 'PATH 上未找到 docker', mode: 'auto' });
    assert.match(request.message, /未检测到可用的沙盒隔离环境/);
    assert.match(request.message, /Docker 未安装或未启动/);
    assert.match(request.message, /是否关闭沙盒模式并继续/);
    assert.match(request.detail, /检测结果/);
    assert.match(request.detail, /PATH 上未找到 docker/);
    eq(request.options.map((option) => option.id), ['keep_sandbox', 'disable_sandbox']);
    const disable = request.options.find((option) => option.id === 'disable_sandbox');
    const keep = request.options.find((option) => option.id === 'keep_sandbox');
    // 风险说明保留在「关闭沙盒」选项描述中（文案修改后仍不丢失警示）
    assert.match(disable.description, /AI 生成的代码会直接接触宿主系统/);
    eq(parseSandboxConsentAnswer({ answers: [{ id: 'dacw-sandbox-consent', selected: [disable.label] }] }, request), { decision: 'disable_sandbox' });
    eq(parseSandboxConsentAnswer({ answers: [{ id: 'dacw-sandbox-consent', selected: [keep.label] }] }, request), { decision: 'keep_sandbox' });
    // 无回答 / 未知选项 / 结构非法 → 一律 keep（fail-closed）
    eq(parseSandboxConsentAnswer(null, request), { decision: 'keep_sandbox' });
    eq(parseSandboxConsentAnswer({ answers: [{ id: 'dacw-sandbox-consent', selected: ['某个未知选项'] }] }, request), { decision: 'keep_sandbox' });
    eq(parseSandboxConsentAnswer({ answers: [] }, request), { decision: 'keep_sandbox' });
});
t('插件配置：sandbox 默认 auto（不告警）；显式 host 才告警并标记 explicit', () => {
    // workspacePolicy 显式给出，避免触发既有的"缺省 workspacePolicy"告警，隔离本用例的断言面
    const defaults = normalizePluginConfig({ workspacePolicy: 'guarded' });
    assert.equal(defaults.config.sandbox.mode, 'auto');
    assert.equal(defaults.sandboxExplicit, false);
    assert.equal(defaults.warnings.length, 0, JSON.stringify(defaults.warnings));  // 默认值不告警
    const explicit = normalizePluginConfig({ sandbox: { mode: 'host' } });
    assert.equal(explicit.sandboxExplicit, true);
    assert.ok(explicit.warnings.some((w) => w.includes('宿主用户全权限')), JSON.stringify(explicit.warnings));
    // 显式选了容器模式，不算"显式宿主直执"
    assert.equal(normalizePluginConfig({ sandbox: { mode: 'auto' } }).sandboxExplicit, false);
});

// ================= isValidWorkspaceMarker：工作区标记必须校验内容 =================
t('合法标记（当前 managedBy 或 0.1 时代旧值）通过', () => {
    assert.equal(isValidWorkspaceMarker(JSON.stringify({ managedBy: '@stmcw1/dacw', version: '1.0.0' })), true);
    // 旧包名 @local/dacw 写入的标记继续接受，避免升级后既有工作区失效
    assert.equal(isValidWorkspaceMarker(JSON.stringify({ managedBy: '@local/dacw', version: '0.1.0' })), true);
});
t('标记内容非法必须拒绝', () => {
    assert.equal(isValidWorkspaceMarker(''), false);
    assert.equal(isValidWorkspaceMarker('not json'), false);
    assert.equal(isValidWorkspaceMarker('[]'), false);
    assert.equal(isValidWorkspaceMarker('null'), false);
    assert.equal(isValidWorkspaceMarker(JSON.stringify({ managedBy: 'someone-else' })), false);
    assert.equal(isValidWorkspaceMarker(JSON.stringify({ note: 'no owner' })), false);
});

// ================= extractTextBlocks：子代理结果取文本 =================
t('文本块拼接并裁剪', () => {
    assert.equal(extractTextBlocks([
        { type: 'text', text: '  hello ' },
        { type: 'reasoning', text: 'ignore me' },
        { type: 'text', text: 'world' },
    ]), 'hello \nworld');
});
t('非数组/空输出 → 空串', () => {
    assert.equal(extractTextBlocks(null), '');
    assert.equal(extractTextBlocks([]), '');
});

// ================= 模型配置解析：读取/使用 DSH 已配置模型 =================
t('模型解析：null/inherit → 继承父会话路由', () => {
    eq(parseModelSpec(null), { mode: 'inherit' });
    eq(parseModelSpec('inherit'), { mode: 'inherit' });
    eq(parseModelSpec('  INHERIT '), { mode: 'inherit' });
    eq(parseModelSpec(''), { mode: 'inherit' });
});
t('模型解析："provider/model" 与对象形式 → 显式模型', () => {
    eq(parseModelSpec('deepseek-account/deepseek-flash'),
        { mode: 'explicit', provider: 'deepseek-account', model: 'deepseek-flash' });
    eq(parseModelSpec({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }),
        { mode: 'explicit', provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });
});
t('模型解析：纯模型名 → 待 DSH 目录解析 provider', () => {
    eq(parseModelSpec('deepseek-flash'), { mode: 'model-only', model: 'deepseek-flash' });
    eq(parseModelSpec({ model: 'glm-5.3' }), { mode: 'model-only', model: 'glm-5.3' });
});
t('模型解析：只有 provider 没有 model → invalid', () => {
    assert.equal(parseModelSpec({ provider: 'deepseek' }).mode, 'invalid');
});
t('模型标签：显式标签与继承标签', () => {
    assert.equal(formatModelLabel('deepseek', 'deepseek-chat'), 'deepseek/deepseek-chat');
    assert.equal(formatModelLabel('deepseek', 'deepseek-chat', 'high'), 'deepseek/deepseek-chat（reasoning=high）');
    assert.equal(formatInheritLabel({ provider: 'deepseek-account', model: 'deepseek-flash' }),
        '继承父会话路由（DSH 默认: deepseek-account/deepseek-flash）');
    assert.equal(formatInheritLabel(null), '继承父会话路由');
    assert.equal(formatInheritLabel({ provider: 'x' }), '继承父会话路由');
});

const CATALOGUE = [
    { provider: 'deepseek-account', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-pro' }] },
    { provider: 'glm', models: [{ id: 'glm-5.3', name: 'GLM 5.3' }] },
    { provider: 'pi', models: [{ id: 'shared-model', name: 'Shared' }] },
    { provider: 'acme', models: [{ id: 'shared-model' }] },
];
t('模型目录：唯一模型 id 匹配出 provider', () => {
    eq(matchModelInCatalogue('deepseek-flash', CATALOGUE), { provider: 'deepseek-account', matchedBy: 'id' });
});
t('模型目录：按显示名匹配', () => {
    eq(matchModelInCatalogue('GLM 5.3', CATALOGUE), { provider: 'glm', matchedBy: 'name' });
});
t('模型目录：跨 provider 同名 → 报歧义并提示写成 provider/model', () => {
    const result = matchModelInCatalogue('shared-model', CATALOGUE);
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, /多个 provider/);
    assert.match(result.error, /pi, acme/);
    assert.match(result.error, /provider\/model/);
});
t('模型目录：找不到 → 错误里给可用候选', () => {
    const result = matchModelInCatalogue('no-such-model', CATALOGUE);
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, /找不到/);
    assert.match(result.error, /deepseek-account\/deepseek-flash/);
});
t('模型目录：空目录 → 明确报错', () => {
    const result = matchModelInCatalogue('any-model', []);
    assert.match(result.error, /目录为空/);
});
t('插件配置：模型字段接受字符串/对象/inherit，非法类型告警回退', () => {
    const strings = normalizePluginConfig({
        workspacePolicy: 'guarded',
        writerModel: 'deepseek-flash',
        reviewerModel: 'deepseek-account/deepseek-flash',
    });
    assert.equal(strings.warnings.length, 0);
    assert.equal(strings.config.writerModel, 'deepseek-flash');
    assert.equal(strings.config.reviewerModel, 'deepseek-account/deepseek-flash');
    const objects = normalizePluginConfig({ workspacePolicy: 'guarded', writerModel: { model: 'glm-5.3', reasoningEffort: 'high' } });
    eq(objects.config.writerModel, { model: 'glm-5.3', reasoningEffort: 'high' });
    assert.equal(normalizePluginConfig({ workspacePolicy: 'guarded', writerModel: 'inherit' }).config.writerModel, null);
    const invalid = normalizePluginConfig({ workspacePolicy: 'guarded', writerModel: 42 });
    assert.equal(invalid.config.writerModel, null);
    assert.equal(invalid.warnings.length, 1);
});
t('引擎配置：roleModels 合法传入，非法忽略', () => {
    const labels = { writer: 'deepseek/deepseek-chat（插件配置）', reviewer: '继承父会话路由' };
    eq(resolveEngineOptions({ roleModels: labels }).roleModels, labels);
    assert.equal(resolveEngineOptions({ roleModels: { writer: 1 } }).roleModels, null);
    assert.equal(resolveEngineOptions(null).roleModels, null);
});

// ================= buildActivationSpec：子代理会话契约 =================
const parent = { id: 'parent-1' };
const signal = { aborted: false };

t('写手 spec：caller 交付 + 专用 preset + 模型覆盖', () => {
    const spec = buildActivationSpec({
        config: DEFAULT_PLUGIN_CONFIG, role: 'writer', text: 'write it', parent,
        cwd: 'E:\\work', presetId: 'dacw-writer', signal,
        model: { provider: 'deepseek', model: 'deepseek-chat' },
    });
    eq(spec, {
        provider: 'spawn',
        label: 'dacw-writer',
        request: {
            prompt: [{ type: 'text', text: 'write it' }],
            parent,
            cwd: 'E:\\work',
            agentPreset: 'dacw-writer',
            agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
        },
        signal,
        delivery: 'caller',
    });
});
t('审查者 spec：继承模式不传 agentOptions', () => {
    const spec = buildActivationSpec({
        config: DEFAULT_PLUGIN_CONFIG, role: 'reviewer', text: 'review it', parent,
        cwd: 'E:\\work', presetId: null, signal, model: null,
    });
    assert.equal(spec.label, 'dacw-reviewer');
    assert.equal(spec.request.agentPreset, undefined);
    assert.equal(spec.request.agentOptions, undefined);
    assert.equal(spec.delivery, 'caller');
});
t('spec：模型 reasoningEffort 透传到 agentOptions', () => {
    const spec = buildActivationSpec({
        config: DEFAULT_PLUGIN_CONFIG, role: 'reviewer', text: 'review it', parent,
        cwd: '', presetId: 'dacw-reviewer', signal,
        model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    });
    eq(spec.request.agentOptions, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });
});

// ================= prepareWorkspace：工作区安全闸门（临时目录，不触碰用户数据） =================
async function ta(name, fn) {
    try { await fn(); pass += 1; console.log(`PASS ${name}`); }
    catch (error) { fail += 1; console.log(`FAIL ${name}\n  ${error && error.message ? error.message : error}`); }
}
async function rejects(fn) {
    let result;
    try { result = await fn(); } catch { return; }
    assert.fail(`expected rejection, got ${JSON.stringify(result)}`);
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dacw-selftest-'));
try {
    await ta('工作区闸门：空目录被接受并写入合法标记', async () => {
        const resolved = await prepareWorkspace(tmpRoot, 'empty', 'guarded');
        assert.equal(resolved, await fs.realpath(path.join(tmpRoot, 'empty')));
        assert.equal(isValidWorkspaceMarker(await fs.readFile(path.join(resolved, '.dacw-workspace'), 'utf-8')), true);
    });
    await ta('工作区闸门：带合法标记的目录可重复使用', async () => {
        await prepareWorkspace(tmpRoot, 'empty', 'guarded');
    });
    await ta('工作区闸门：非空且无标记必须拒绝', async () => {
        const dir = path.join(tmpRoot, 'dirty');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'keep.txt'), 'x');
        await rejects(() => prepareWorkspace(tmpRoot, 'dirty', 'guarded'));
    });
    await ta('工作区闸门：伪造标记（managedBy 不匹配）必须拒绝', async () => {
        const dir = path.join(tmpRoot, 'fake-marker');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, '.dacw-workspace'), '{"managedBy":"someone-else"}');
        await rejects(() => prepareWorkspace(tmpRoot, 'fake-marker', 'guarded'));
    });
    await ta('工作区闸门：allow 策略接受非空目录', async () => {
        const resolved = await prepareWorkspace(tmpRoot, 'dirty', 'allow');
        assert.equal(resolved, await fs.realpath(path.join(tmpRoot, 'dirty')));
    });
    await ta('工作区闸门：拒绝用户主目录', async () => rejects(() => prepareWorkspace(tmpRoot, os.homedir(), 'guarded')));
    await ta('工作区闸门：拒绝文件系统根', async () => rejects(() => prepareWorkspace(tmpRoot, path.parse(tmpRoot).root, 'guarded')));

    await ta('enumerateWorkspace：根级忽略、嵌套同名条目不忽略、路径 / 分隔、SHA256、符号链接拒绝', async () => {
        const dir = path.join(tmpRoot, 'enum-ws');
        await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
        await fs.mkdir(path.join(dir, 'node_modules', 'dep'), { recursive: true });
        await fs.mkdir(path.join(dir, '.git'), { recursive: true });
        await fs.mkdir(path.join(dir, 'sub', '.git'), { recursive: true });
        await fs.mkdir(path.join(dir, 'sub', 'node_modules'), { recursive: true });
        await fs.writeFile(path.join(dir, 'sub', 'a.txt'), 'hello');
        await fs.writeFile(path.join(dir, 'node_modules', 'dep', 'index.js'), 'dep');
        await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref');
        await fs.writeFile(path.join(dir, 'sub', '.git', 'config'), 'nested-git');
        await fs.writeFile(path.join(dir, 'sub', 'node_modules', 'nested.js'), 'nested');
        await fs.writeFile(path.join(dir, '.dacw-workspace'), '{}');
        await fs.writeFile(path.join(dir, 'root.txt'), 'r');
        const digest = await enumerateWorkspace(dir);
        // F1：根级 .git/node_modules/.dacw-workspace 不进入文件摘要；子目录同名条目正常纳入
        eq(Array.from(digest.keys()), ['root.txt', 'sub/.git/config', 'sub/a.txt', 'sub/node_modules/nested.js']);
        assert.equal(digest.get('sub/a.txt'), crypto.createHash('sha256').update('hello').digest('hex'));
        // 符号链接必须拒绝；Windows 非管理员可能无法创建链接（EPERM），此时跳过该断言
        let linked = false;
        try {
            await fs.symlink(path.join(dir, 'root.txt'), path.join(dir, 'link.txt'));
            linked = true;
        } catch { /* 无权限创建符号链接：跳过 */ }
        if (linked) await rejects(() => enumerateWorkspace(dir));
    });
    await ta('fingerprintProtectedDirs：只对顶层条目做指纹（内容变化不影响，增删条目即变化）', async () => {
        const dir = path.join(tmpRoot, 'fp-ws');
        await fs.mkdir(path.join(dir, 'node_modules', 'dep'), { recursive: true });
        await fs.mkdir(path.join(dir, '.git'), { recursive: true });
        await fs.writeFile(path.join(dir, 'node_modules', 'dep', 'index.js'), 'dep', 'utf8');
        await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref', 'utf8');
        const before = await fingerprintProtectedDirs(dir);
        eq(Array.from(before.keys()), ['.git', 'node_modules']);
        // 递归内容变化：顶层指纹不变
        await fs.writeFile(path.join(dir, 'node_modules', 'dep', 'index.js'), 'dep2', 'utf8');
        const same = await fingerprintProtectedDirs(dir);
        eq(Array.from(same.entries()), Array.from(before.entries()));
        // 顶层条目增删：指纹变化
        await fs.writeFile(path.join(dir, 'node_modules', 'injected.js'), 'x', 'utf8');
        const changed = await fingerprintProtectedDirs(dir);
        assert.notEqual(changed.get('node_modules'), before.get('node_modules'));
        // 目录缺失：不记录（缺失/新建由 diff 的 -/+ 表达）
        const missing = await fingerprintProtectedDirs(path.join(tmpRoot, 'fp-missing'));
        eq(Array.from(missing.keys()), []);
    });

    // ---- 隔离 fail-closed（E 组）：无法确认隔离即终止，绝不记为成功 ----
    const makeIsolation = () => ({ enabled: true, restricted: new Set(), disposers: new Map(), applied: 0, failures: 0, lastError: '' });
    const quietLogger = () => ({ info() { }, warn() { }, error() { } });

    await ta('隔离：provider 未返回 childId → dispose 后抛错，不继续运行', async () => {
        let disposed = false;
        const subagents = {
            startActivation: async () => ({
                childId: '',
                dispose: async () => { disposed = true; },
                result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'should-not-run' }] }),
            }),
        };
        await assert.rejects(
            () => runSubagentChat({
                subagents,
                config: DEFAULT_PLUGIN_CONFIG,
                presets: { ready: true },
                isolation: makeIsolation(),
                agent: { id: 'parent' },
                workspaceDir: tmpRoot,
                signal: undefined,
                role: 'writer',
                text: 'x',
                dacwChildren: new Set(),
                logger: quietLogger(),
                roleModel: { agentOptions: null, label: 'inherit', source: 'inherit' },
            }),
            /未返回有效 childId/);
        assert.equal(disposed, true);
    });
    await ta('隔离：enforce=true 但 preset 不可用 → dispose 后抛错（allowInheritedPresets 不构成旁路）', async () => {
        let disposed = false;
        const subagents = {
            startActivation: async () => ({
                childId: 'child-inherited',
                dispose: async () => { disposed = true; },
                result: Promise.resolve({ stopReason: 'completed', output: [] }),
            }),
        };
        await assert.rejects(
            () => runSubagentChat({
                subagents,
                config: { ...DEFAULT_PLUGIN_CONFIG, allowInheritedPresets: true },
                presets: { ready: false, reason: '测试用：preset 注册失败' },
                isolation: makeIsolation(),
                agent: { id: 'parent' },
                workspaceDir: tmpRoot,
                signal: undefined,
                role: 'writer',
                text: 'x',
                dacwChildren: new Set(),
                logger: quietLogger(),
                roleModel: { agentOptions: null, label: 'inherit', source: 'inherit' },
            }),
            /preset 不可用/);
        assert.equal(disposed, true);
    });
    await ta('隔离：缺少 tools.schemas → 抛错、不计 applied、打"无法验证"日志', async () => {
        const ctx = { tools: { schemas: () => [{ name: 'dacw_run' }] } };
        const agent = { id: 'child-noschema', ctx: { tools: { restrict: () => () => { } } } };
        const isolation = makeIsolation();
        const errors = [];
        const logger = { info() { }, warn() { }, error: (message) => errors.push(message) };
        assert.throws(() => restrictChildTools(ctx, agent, isolation, logger), /tools\.schemas/);
        assert.equal(isolation.applied, 0);
        assert.equal(isolation.failures, 1);
        assert.equal(isolation.restricted.has('child-noschema'), false);
        assert.ok(errors.some((line) => line.includes('隔离已应用但无法验证')), JSON.stringify(errors));
    });
    await ta('隔离：allow:[] 不可用且宿主缺少 ctx.tools.schemas → 拒绝回退、抛错', async () => {
        const ctx = { tools: {} };
        const agent = { id: 'child-fallback', ctx: { tools: { restrict: () => { throw new Error('allow:[] unsupported'); } } } };
        const isolation = makeIsolation();
        assert.throws(() => restrictChildTools(ctx, agent, isolation, quietLogger()), /无法安全回退/);
        assert.equal(isolation.applied, 0);
        assert.equal(isolation.failures, 1);
    });
    await ta('隔离：restrict 成功且 schemas 返回空数组才记成功（applied=1，日志 0 个）', async () => {
        const ctx = { tools: { schemas: () => [{ name: 'dacw_run' }] } };
        const agent = { id: 'child-ok', ctx: { tools: { restrict: () => () => { }, schemas: () => [] } } };
        const isolation = makeIsolation();
        const infos = [];
        const logger = { info: (message) => infos.push(message), warn() { }, error() { } };
        restrictChildTools(ctx, agent, isolation, logger);
        assert.equal(isolation.applied, 1);
        assert.equal(isolation.failures, 0);
        assert.equal(isolation.restricted.has('child-ok'), true);
        assert.equal(isolation.disposers.size, 1);
        assert.ok(infos.some((line) => line.includes('隔离后可见工具 0 个')), JSON.stringify(infos));
    });

    await ta('运行机：blocked 策略拒绝执行测试（fail-closed，不启动任何进程）', async () => {
        const runner = new Runner(tmpRoot, { kind: 'blocked', reason: '测试用：Docker 不可用' });
        const result = await runner.run('npm', ['run', 'test'], 1000);
        assert.equal(result.success, false);
        assert.equal(result.timedOut, false);
        assert.match(result.output, /测试未执行/);
        assert.match(result.output, /运行机拒绝执行测试/);
    });
    await ta('运行机：非白名单命令一律拒绝（甚至不进入策略分支）', async () => {
        const runner = new Runner(tmpRoot, { kind: 'blocked', reason: '测试用' });
        const result = await runner.run('powershell', ['-Command', 'whoami'], 1000);
        assert.equal(result.success, false);
        assert.match(result.output, /未授权命令/);
    });
    await ta('运行机：host 策略可执行 node 并回传输出（显式 host 才走宿主）', async () => {
        const prevPath = process.env.PATH;
        process.env.PATH = path.dirname(process.execPath) + path.delimiter + (prevPath ?? '');
        try {
            const runner = new Runner(tmpRoot, { kind: 'host' });
            const result = await runner.run('node', ['-e', 'process.stdout.write("hello-host")'], 15000);
            assert.equal(result.success, true, result.output);
            assert.match(result.output, /hello-host/);
        } finally {
            process.env.PATH = prevPath;
        }
    });

    // ---- 测试后对账（不变量 6）：假 npm 模拟「测试期改写工作区」 ----
    const makeFakeNpm = async (name, scriptBody) => {
        const binDir = path.join(tmpRoot, name, 'bin');
        await fs.mkdir(path.join(binDir, 'node_modules', 'npm', 'bin'), { recursive: true });
        await fs.writeFile(path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), scriptBody, 'utf8');
        if (process.platform === 'win32') {
            await fs.writeFile(path.join(binDir, 'npm.cmd'), '@echo off\r\n', 'utf8');
        } else {
            await fs.writeFile(path.join(binDir, 'npm'), '#!/usr/bin/env node\n' + scriptBody, 'utf8');
            await fs.chmod(path.join(binDir, 'npm'), 0o755);
        }
        return binDir;
    };

    const runReconWorkflow = async (tag, scriptBody, prepare, reviewerAction, extraOptions, askUserQuestion) => {
        const binDir = await makeFakeNpm(`fake-npm-${tag}`, scriptBody);
        const wsDir = path.join(tmpRoot, `ws-recon-${tag}`);
        await fs.mkdir(wsDir, { recursive: true });
        await fs.writeFile(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }), 'utf8');
        if (prepare) await prepare(wsDir);
        const prevPath = process.env.PATH;
        process.env.PATH = binDir + path.delimiter + path.dirname(process.execPath) + path.delimiter + (prevPath ?? '');
        try {
            const logs = [];
            let reviewerCalled = false;
            let reviewerInput = '';
            const context = {
                chat: async (agentId, _prompt, contextText) => {
                    if (agentId === 'reviewer-agent') {
                        reviewerCalled = true;
                        reviewerInput = contextText;
                        if (reviewerAction) await reviewerAction(wsDir);
                        return '{"verdict":"PASS"}';
                    }
                    return JSON.stringify({ changed: [{ file: 'main.js', code: 'console.log(1);\n' }], deleted: [] });
                },
                log: (message) => logs.push(message),
                ...(askUserQuestion ? { askUserQuestion } : {}),
            };
            const execute = engine.apply(context, {
                maxRounds: 1,
                stateDir: path.join(tmpRoot, `state-recon-${tag}`),
                // 回归测试默认显式走宿主策略，避免依赖本机 Docker 是否存在；
                // 沙盒确认流程的用例会通过 extraOptions 覆盖 sandbox/sandboxDetect。
                sandbox: { mode: 'host' },
                ...(extraOptions ?? {}),
            });
            const result = await execute(`selftest-recon-${tag}`, wsDir, 'task');
            return { result, reviewerCalled, reviewerInput, logs };
        } finally {
            process.env.PATH = prevPath;
        }
    };

    await ta('对账：测试脚本新建 unreviewed.js → success:false、转人工、不进入审查', async () => {
        const script = "const fs = require('node:fs');\nfs.writeFileSync('unreviewed.js', 'console.log(\"injected\");\\n');\n";
        const { result, reviewerCalled } = await runReconWorkflow('add', script);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /unreviewed\.js/);
        assert.match(result.message, /\+ 新增/);
        assert.equal(reviewerCalled, false);
    });
    await ta('对账：测试脚本改写已生成文件 → success:false、转人工、message 含 ~ 标记', async () => {
        const script = "const fs = require('node:fs');\nfs.appendFileSync('main.js', '\\n// tampered by test\\n');\n";
        const { result, reviewerCalled } = await runReconWorkflow('modify', script);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /main\.js/);
        assert.match(result.message, /~ 内容变更/);
        assert.equal(reviewerCalled, false);
    });
    await ta('对账：测试未改动工作区 → 进入审查；files 与审查输入均来自最终清单', async () => {
        const { result, reviewerCalled, reviewerInput } = await runReconWorkflow('clean', 'process.exit(0);');
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, true);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.ok(Array.isArray(result.files));
        assert.ok(result.files.includes('main.js'), JSON.stringify(result.files));
        assert.ok(result.files.includes('package.json'), JSON.stringify(result.files));
        assert.match(reviewerInput, /--- 文件: main\.js ---/);
        assert.match(reviewerInput, /--- 文件: package\.json ---/);
    });

    // ---- F 组：递归忽略绕过（F1）、根级受保护目录指纹（F2）、最终三边界一致性（F3） ----
    await ta('F1：测试在 nested/node_modules 投放 payload.js → 检测为 + 新增、转人工、不进入审查', async () => {
        const script = `const fs = require('node:fs');
fs.mkdirSync('nested/node_modules', { recursive: true });
fs.writeFileSync('nested/node_modules/payload.js', '// injected by test');
`;
        const { result, reviewerCalled } = await runReconWorkflow('f1-nested', script);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /nested\/node_modules\/payload\.js/);
        assert.match(result.message, /\+ 新增/);
        assert.equal(reviewerCalled, false);
    });
    await ta('F2：测试新增根级 node_modules 顶层条目 → 指纹变化、转人工、不进入审查', async () => {
        const script = `const fs = require('node:fs');
fs.writeFileSync('node_modules/injected.js', '// injected by test');
`;
        const prepare = async (wsDir) => {
            await fs.mkdir(path.join(wsDir, 'node_modules', 'dep'), { recursive: true });
            await fs.writeFile(path.join(wsDir, 'node_modules', 'dep', 'index.js'), 'dep', 'utf8');
        };
        const { result, reviewerCalled } = await runReconWorkflow('f2-mutation', script, prepare);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /受保护目录/);
        assert.match(result.message, /node_modules/);
        assert.equal(reviewerCalled, false);
    });
    await ta('F2：根级 node_modules/.git 正常存在且未被测试改动 → 不误报、正常进入审查', async () => {
        const prepare = async (wsDir) => {
            await fs.mkdir(path.join(wsDir, 'node_modules', 'dep'), { recursive: true });
            await fs.writeFile(path.join(wsDir, 'node_modules', 'dep', 'index.js'), 'dep', 'utf8');
            await fs.mkdir(path.join(wsDir, '.git'), { recursive: true });
            await fs.writeFile(path.join(wsDir, '.git', 'HEAD'), 'ref', 'utf8');
        };
        const { result, reviewerCalled, reviewerInput } = await runReconWorkflow('f2-clean', 'process.exit(0);', prepare);
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, true);
        assert.deepEqual(
            result.files.filter((file) => file === 'node_modules' || file.startsWith('node_modules/') || file === '.git' || file.startsWith('.git/')),
            [],
            JSON.stringify(result.files));
        assert.ok(result.files.includes('main.js'), JSON.stringify(result.files));
        assert.doesNotMatch(reviewerInput, /--- 文件: (node_modules|\.git)/);
    });
    await ta('F3：审查期间工作区被改动 → 三边界断言失败、success:false', async () => {
        const reviewerAction = async (wsDir) => {
            await fs.writeFile(path.join(wsDir, 'late-append.js'), '// written during review', 'utf8');
        };
        const { result, reviewerCalled } = await runReconWorkflow('f3-window', 'process.exit(0);', null, reviewerAction);
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /最终一致性断言失败/);
        assert.match(result.message, /审查期间工作区文件发生变动/);
        assert.match(result.message, /late-append\.js/);
    });

    // ---- G 组：截断 / 摘要送审 fail-closed（G1–G3） ----
    await ta('G1：单文件截断（reviewFileMaxChars 超限）→ 审查者 PASS 也 success:false', async () => {
        const { result, reviewerCalled } = await runReconWorkflow('g1-trunc', 'process.exit(0);', null, null, { reviewFileMaxChars: 10 });
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /审查不完整/);
        assert.match(result.message, /单文件截断/);
        assert.match(result.message, /main\.js/);
        assert.match(result.message, /总输入上限/);
    });
    await ta('G2：锁文件仅摘要送审 → 视为未完整审查、success:false', async () => {
        const prepare = async (wsDir) => {
            await fs.writeFile(path.join(wsDir, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3 }), 'utf8');
        };
        const { result, reviewerCalled } = await runReconWorkflow('g2-lock', 'process.exit(0);', prepare);
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /仅摘要送审的锁文件/);
        assert.match(result.message, /package-lock\.json/);
        assert.match(result.message, /未送语义审查/);
        assert.match(result.message, /对账保证/);
    });
    await ta('G3：allowTruncatedReview=true 时截断可 PASS，但 message/files/日志必须标注降级', async () => {
        const { result, reviewerCalled, logs } = await runReconWorkflow('g3-escape', 'process.exit(0);', null, null, {
            reviewFileMaxChars: 10,
            allowTruncatedReview: true,
        });
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, true);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /安全降级/);
        assert.ok(result.files.some((file) => file.includes('（审查输入被截断，未完整送审）')), JSON.stringify(result.files));
        assert.ok(logs.some((line) => line.includes('[安全降级]')), JSON.stringify(logs));
    });

    // ---- 沙盒确认：Docker 不可用时不崩溃、不静默降级，而是询问人类是否关闭沙盒 ----
    const failingDetect = async () => ({ ok: false, reason: '测试用：Docker 未安装' });
    await ta('沙盒确认：用户选择关闭沙盒 → 宿主继续执行，message/日志标注安全降级', async () => {
        const seen = { request: null };
        const askUserQuestion = async (request) => {
            seen.request = request;
            return { decision: 'disable_sandbox' };
        };
        const { result, reviewerCalled, logs } = await runReconWorkflow('sandbox-disable', 'process.exit(0);', null, null, {
            sandbox: { mode: 'auto' },
            sandboxDetect: failingDetect,
        }, askUserQuestion);
        assert.ok(seen.request && seen.request.message.includes('未检测到可用的沙盒隔离环境'), '未弹出沙盒确认请求');
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, true);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /安全降级/);
        assert.match(result.message, /关闭沙盒/);
        assert.ok(logs.some((line) => line.includes('[安全降级]')), JSON.stringify(logs));
    });
    await ta('沙盒确认：用户选择保持沙盒 → 拒绝运行、未执行测试、message 含检测内容', async () => {
        const askUserQuestion = async () => ({ decision: 'keep_sandbox' });
        const { result, reviewerCalled } = await runReconWorkflow('sandbox-keep', 'process.exit(0);', null, null, {
            sandbox: { mode: 'auto' },
            sandboxDetect: failingDetect,
        }, askUserQuestion);
        assert.equal(reviewerCalled, false);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /未检测到可用的沙盒隔离环境/);
        assert.match(result.message, /未关闭沙盒/);
        assert.match(result.message, /保持沙盒/);
    });
    await ta('沙盒确认：宿主无交互能力 → fail-closed 拒绝（不崩溃、不静默降级）', async () => {
        const { result, reviewerCalled } = await runReconWorkflow('sandbox-noask', 'process.exit(0);', null, null, {
            sandbox: { mode: 'auto' },
            sandboxDetect: failingDetect,
        });
        assert.equal(reviewerCalled, false);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /未检测到可用的沙盒隔离环境/);
        assert.match(result.message, /未关闭沙盒/);
        assert.match(result.message, /交互确认能力/);
    });

    await ta('引擎启动日志：显示写手/审查者模型配置', async () => {
        const logs = [];
        const context = { chat: async () => '不是 JSON', log: (message) => logs.push(message) };
        const execute = engine.apply(context, {
            maxRounds: 1,
            stateDir: path.join(tmpRoot, 'state'),
            roleModels: { writer: 'deepseek-account/deepseek-flash（插件配置）', reviewer: '继承父会话路由' },
        });
        const result = await execute('selftest-model-log', path.join(tmpRoot, 'ws'), 'task');
        assert.equal(result.status, 'NEED_HUMAN');
        assert.ok(
            logs.some((line) => line.includes('🧠 模型配置')
                && line.includes('deepseek-account/deepseek-flash（插件配置）')
                && line.includes('继承父会话路由')),
            `日志里没有模型配置行：${JSON.stringify(logs)}`,
        );
    });
    await ta('引擎审计日志：默认 auto 沙盒策略；显式 host 出现红色警告', async () => {
        const runEngine = async (options, tag) => {
            const logs = [];
            const context = { chat: async () => '不是 JSON', log: (message) => logs.push(message) };
            const execute = engine.apply(context, {
                maxRounds: 1,
                stateDir: path.join(tmpRoot, `state-grading-${tag}`),
                sandboxDetect: async () => ({ ok: true, version: 'selftest' }),
                ...options,
            });
            await execute(`selftest-grading-${tag}`, path.join(tmpRoot, `ws-grading-${tag}`), 'task');
            return logs;
        };
        const defaultLogs = await runEngine({}, 'default');
        assert.ok(defaultLogs.some((line) => line.includes('测试执行策略')), JSON.stringify(defaultLogs));
        assert.ok(defaultLogs.some((line) => line.includes('一次性 Docker 容器')), `缺默认沙盒策略提示：${JSON.stringify(defaultLogs)}`);
        assert.equal(
            defaultLogs.some((line) => line.includes('你显式配置了 sandbox.mode="host"')),
            false, '默认值不应出现红色 host 警告');
        const explicitLogs = await runEngine({ sandbox: { mode: 'host' }, sandboxExplicit: true }, 'explicit');
        assert.ok(
            explicitLogs.some((line) => line.includes('你显式配置了 sandbox.mode="host"')),
            `缺显式 host 警告：${JSON.stringify(explicitLogs)}`);
    });
} finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
