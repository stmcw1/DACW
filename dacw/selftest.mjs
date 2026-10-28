// DACW 纯函数回归自测。
//
// 运行：node build.mjs && node selftest.mjs
// 原理：直接加载构建产物 dist/（插件运行时真正加载的代码），对导出的纯函数跑回归向量。
//      不执行工作流、不写文件系统、不调用任何模型。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const engine = await import('./dist/index.js');
const plugin = await import('./dist/plugin.js');

const { parseWriterDelta, parseReviewVerdict, mergeDelta, resolveEngineOptions, DEFAULT_ENGINE_OPTIONS } = engine;
const {
    normalizePluginConfig, extractTextBlocks, buildActivationSpec, isValidWorkspaceMarker, prepareWorkspace,
    parseModelSpec, matchModelInCatalogue, formatModelLabel, formatInheritLabel, DEFAULT_PLUGIN_CONFIG,
} = plugin;

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
} finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
