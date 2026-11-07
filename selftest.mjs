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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const engine = await import('./dist/index.js');
const plugin = await import('./dist/plugin.js');
const sandbox = await import('./dist/sandbox.js');
const runnerModule = await import('./dist/runner.js');
const secretsModule = await import('./dist/secrets.js');

const { redactSecretsInText } = secretsModule;

const {
    parseWriterDelta, parseReviewVerdict, mergeDelta, resolveEngineOptions, DEFAULT_ENGINE_OPTIONS,
    enumerateWorkspace, diffDigest, fingerprintProtectedDirs, isSensitiveReviewFile, scanWriterOutputForSecrets,
    captureRollbackPoint, rollbackTask,
} = engine;
const {
    normalizePluginConfig, extractTextBlocks, buildActivationSpec, isValidWorkspaceMarker, prepareWorkspace,
    parseModelSpec, matchModelInCatalogue, formatModelLabel, formatInheritLabel, DEFAULT_PLUGIN_CONFIG,
    restrictChildTools, runSubagentChat, apply: applyPlugin,
} = plugin;
const { StateManager } = await import('./dist/state_manager.js');
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
t('敏感文件识别：常见秘密文件命中、普通源码不命中（子目录同样生效）', () => {
    for (const file of ['.env', '.env.local', 'config/server.pem', 'keys/client.key', 'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.yaml', '.npmrc', '.netrc', 'a/b/private.p12', 'docs/secret.md']) {
        assert.equal(isSensitiveReviewFile(file), true, file);
    }
    for (const file of ['src/app.js', 'README.md', 'package.json', '.envrc', 'src/keystore.ts']) {
        assert.equal(isSensitiveReviewFile(file), false, file);
    }
});
t('秘密扫描：五类凭据模式命中并返回人话类别（不含原文），首个命中即停', () => {
    const changed = (code, file = 'x.js') => ({ changed: [{ file, code }], deleted: [], legacyFull: false });
    const cases = [
        ['PEM 私钥', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'],
        ['AWS Access Key', 'const k = "AKIAABCDEFGHIJKLMNOP";'],
        ['GitHub Token', 'ghp_' + 'a'.repeat(36)],
        ['Slack Token', 'xoxb-1234567890-abcdefghij'],
        ['OpenAI Key', 'sk-' + 'a'.repeat(40)],
    ];
    for (const [category, code] of cases) {
        const hit = scanWriterOutputForSecrets(changed(code));
        eq(hit, { file: 'x.js', category });
        assert.ok(!JSON.stringify(hit).includes(code), `命中结果不得包含原文（${category}）`);
    }
    // 首个命中即停：按 delta.changed 顺序 + 模式表顺序返回第一个
    eq(scanWriterOutputForSecrets({
        changed: [
            { file: 'a.js', code: 'console.log(1)' },
            { file: 'b.js', code: 'AKIAABCDEFGHIJKLMNOP' },
            { file: 'c.js', code: '-----BEGIN RSA PRIVATE KEY-----' },
        ],
        deleted: [], legacyFull: false,
    }), { file: 'b.js', category: 'AWS Access Key' });
    // 无命中返回 null
    eq(scanWriterOutputForSecrets(changed('const ok = 1;')), null);
});
t('运行机输出脱敏：五类凭据替换为 [REDACTED:<类别>] 且保留结构、可多命中', () => {
    const samples = [
        ['PEM 私钥', '-----BEGIN RSA PRIVATE KEY-----'],
        ['AWS Access Key', 'AKIAABCDEFGHIJKLMNOP'],
        ['GitHub Token', 'ghp_' + 'a'.repeat(36)],
        ['Slack Token', 'xoxb-1234567890-abcdefghij'],
        ['OpenAI Key', 'sk-' + 'a'.repeat(40)],
    ];
    for (const [category, secret] of samples) {
        const text = `before ${secret} after`;
        eq(redactSecretsInText(text), `before [REDACTED:${category}] after`);
    }
    const multi = redactSecretsInText(`a sk-${'b'.repeat(40)} and AKIAABCDEFGHIJKLMNOP end`);
    assert.match(multi, /\[REDACTED:OpenAI Key\]/);
    assert.match(multi, /\[REDACTED:AWS Access Key\]/);
    eq(redactSecretsInText('no secrets here'), 'no secrets here');
});
t('秘密扫描配置：默认开启，仅显式 false 关闭（引擎 + 插件配置）', () => {
    assert.equal(DEFAULT_ENGINE_OPTIONS.secretScanEnabled, true);
    assert.equal(resolveEngineOptions(null).secretScanEnabled, true);
    assert.equal(resolveEngineOptions({ secretScanEnabled: false }).secretScanEnabled, false);
    const defaults = normalizePluginConfig({ workspacePolicy: 'guarded' });
    assert.equal(defaults.config.secretScanEnabled, true);
    assert.equal(defaults.warnings.length, 0, JSON.stringify(defaults.warnings));
    const off = normalizePluginConfig({ workspacePolicy: 'guarded', secretScanEnabled: false });
    assert.equal(off.config.secretScanEnabled, false);
    assert.ok(off.warnings.some((w) => w.includes('secretScanEnabled')), JSON.stringify(off.warnings));
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
t('沙箱配置：缺省用默认值（host，执行隔离默认关闭）', () => {
    eq(normalizeSandboxConfig(null, [], 'x'), DEFAULT_SANDBOX_CONFIG);
    assert.equal(DEFAULT_SANDBOX_CONFIG.mode, 'host');
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
t('插件配置：sandbox 默认 host（不告警）；显式 host 才告警并标记 explicit', () => {
    // workspacePolicy 显式给出，避免触发既有的"缺省 workspacePolicy"告警，隔离本用例的断言面
    const defaults = normalizePluginConfig({ workspacePolicy: 'guarded' });
    assert.equal(defaults.config.sandbox.mode, 'host');
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
    await ta('运行机：stdout 含 key → RunResult.output 已脱敏（C 组）', async () => {
        const prevPath = process.env.PATH;
        process.env.PATH = path.dirname(process.execPath) + path.delimiter + (prevPath ?? '');
        try {
            const rawKey = 'sk-' + 'c'.repeat(40);
            const runner = new Runner(tmpRoot, { kind: 'host' });
            const result = await runner.run('node', ['-e', `process.stdout.write(${JSON.stringify(rawKey)})`], 15000);
            assert.equal(result.success, true, result.output);
            assert.match(result.output, /\[REDACTED:OpenAI Key\]/);
            assert.ok(!result.output.includes(rawKey), 'RunResult.output 不得包含密钥原文');
        } finally {
            process.env.PATH = prevPath;
        }
    });
    await ta('回滚点：workspace 模式备份整目录（排除 .git/node_modules/.dacw-workspace）', async () => {
        const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
        const wsDir = path.join(tmpRoot, 'rollback-ws');
        await fs.mkdir(path.join(wsDir, 'node_modules'), { recursive: true });
        await fs.mkdir(path.join(wsDir, 'sub', '.git'), { recursive: true });
        await fs.writeFile(path.join(wsDir, 'a.txt'), 'alpha\n', 'utf8');
        await fs.writeFile(path.join(wsDir, 'b.txt'), 'beta\n', 'utf8');
        await fs.writeFile(path.join(wsDir, 'node_modules', 'dep.js'), 'dep\n', 'utf8');
        await fs.writeFile(path.join(wsDir, 'sub', '.git', 'config'), 'x\n', 'utf8');
        await fs.writeFile(path.join(wsDir, '.dacw-workspace'), '{"managedBy":"@stmcw1/dacw"}\n', 'utf8');
        const stateDir = path.join(tmpRoot, 'rollback-state');
        const point = await captureRollbackPoint(wsDir, stateDir, 'task-workspace-1');
        eq(point.mode, 'workspace');
        assert.match(point.ref, /^[0-9a-f]{8}$/);
        assert.ok(!Number.isNaN(Date.parse(point.capturedAt)), point.capturedAt);
        const backupDir = path.join(stateDir, 'backup', point.ref);
        assert.equal(await exists(backupDir), true, '备份目录应存在');
        eq(await fs.readFile(path.join(backupDir, 'a.txt'), 'utf8'), 'alpha\n');
        eq(await fs.readFile(path.join(backupDir, 'b.txt'), 'utf8'), 'beta\n');
        assert.equal(await exists(path.join(backupDir, 'node_modules')), false, 'node_modules 不应备份');
        assert.equal(await exists(path.join(backupDir, 'sub', '.git')), false, '.git 不应备份');
        assert.equal(await exists(path.join(backupDir, '.dacw-workspace')), false, '.dacw-workspace 不应备份');
        // 边界 1：stateDir 位于工作区内 → 拒绝
        await assert.rejects(
            () => captureRollbackPoint(wsDir, path.join(wsDir, 'state'), 'task-workspace-1'),
            /stateDir 不能位于工作区内/);
        // 边界 3：同 taskId 重跑 → 旧备份作废（残留文件不保留）
        await fs.writeFile(path.join(backupDir, 'stale.txt'), 'stale\n', 'utf8');
        const point2 = await captureRollbackPoint(wsDir, stateDir, 'task-workspace-1');
        eq(point2.ref, point.ref);
        assert.equal(await exists(path.join(backupDir, 'stale.txt')), false, '旧备份应作废');
    });
    await ta('回滚点：git 模式记录 HEAD commit（不备份工作区）', async () => {
        const wsDir = path.join(tmpRoot, 'rollback-git');
        await fs.mkdir(wsDir, { recursive: true });
        await fs.writeFile(path.join(wsDir, 'a.txt'), 'git-alpha\n', 'utf8');
        const git = (args) => execFileAsync('git', args, { cwd: wsDir, windowsHide: true });
        await git(['init', '-q']);
        await git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.com', 'add', '-A']);
        await git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.com', 'commit', '-q', '-m', 'init']);
        const { stdout } = await git(['rev-parse', 'HEAD']);
        const stateDir = path.join(tmpRoot, 'rollback-state-git');
        const point = await captureRollbackPoint(wsDir, stateDir, 'task-git-1');
        eq(point.mode, 'git');
        eq(point.ref, stdout.trim());
        // git 模式不产生 workspace 备份目录
        const backupRoot = path.join(stateDir, 'backup');
        let backupExists = true;
        try { await fs.access(backupRoot); } catch { backupExists = false; }
        assert.equal(backupExists, false, 'git 模式不应创建备份目录');
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

    const runReconWorkflow = async (tag, scriptBody, prepare, reviewerAction, extraOptions, askUserQuestion, writerChanged) => {
        const binDir = await makeFakeNpm(`fake-npm-${tag}`, scriptBody);
        const wsDir = path.join(tmpRoot, `ws-recon-${tag}`);
        const stateDir = path.join(tmpRoot, `state-recon-${tag}`);
        const taskId = `selftest-recon-${tag}`;
        await fs.mkdir(wsDir, { recursive: true });
        await fs.writeFile(path.join(wsDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }), 'utf8');
        if (prepare) await prepare(wsDir);
        const prevPath = process.env.PATH;
        process.env.PATH = binDir + path.delimiter + path.dirname(process.execPath) + path.delimiter + (prevPath ?? '');
        try {
            const logs = [];
            let reviewerCalled = false;
            let reviewerInput = '';
            const writerContexts = [];
            const context = {
                chat: async (agentId, _prompt, contextText) => {
                    if (agentId === 'reviewer-agent') {
                        reviewerCalled = true;
                        reviewerInput = contextText;
                        if (reviewerAction) await reviewerAction(wsDir);
                        return '{"verdict":"PASS"}';
                    }
                    // feedback 由引擎写入写手 system prompt（_prompt），user context 通常为空。
                    writerContexts.push(`${_prompt}\n${contextText}`);
                    const changed = writerChanged ?? [{ file: 'main.js', code: 'console.log(1);\n' }];
                    return JSON.stringify({ changed, deleted: [] });
                },
                log: (message) => logs.push(message),
                ...(askUserQuestion ? { askUserQuestion } : {}),
            };
            const execute = engine.apply(context, {
                maxRounds: 1,
                stateDir,
                // 回归测试默认显式走宿主策略，避免依赖本机 Docker 是否存在；
                // 沙盒确认流程的用例会通过 extraOptions 覆盖 sandbox/sandboxDetect。
                sandbox: { mode: 'host' },
                ...(extraOptions ?? {}),
            });
            const result = await execute(taskId, wsDir, 'task');
            return { result, reviewerCalled, reviewerInput, logs, writerContexts, wsDir, stateDir, taskId };
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
            // 回滚点捕获要求 .git 是可用仓库（读不到 HEAD 时 fail-closed）；用真实 git 仓库做夹具。
            const git = (args) => execFileAsync('git', args, { cwd: wsDir, windowsHide: true });
            await git(['init', '-q']);
            await git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.com', 'add', '-A']);
            await git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.com', 'commit', '-q', '-m', 'init']);
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
    await ta('docker 模式不可用：直接拒绝运行，不弹确认、不降级', async () => {
        let asked = false;
        const askUserQuestion = async () => { asked = true; return { decision: 'disable_sandbox' }; };
        const { result, reviewerCalled } = await runReconWorkflow('sandbox-docker', 'process.exit(0);', null, null, {
            sandbox: { mode: 'docker' },
            sandboxDetect: failingDetect,
        }, askUserQuestion);
        assert.equal(asked, false);
        assert.equal(reviewerCalled, false);
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /sandbox\.mode="docker" 要求容器执行/);
        assert.match(result.message, /不询问/);
    });
    await ta('默认 host：不探测 Docker、不弹确认，正常执行', async () => {
        let detected = false;
        let asked = false;
        const { result } = await runReconWorkflow('sandbox-defaulthost', 'process.exit(0);', null, null, {
            sandboxDetect: async () => { detected = true; return { ok: false, reason: '默认 host 不应探测 Docker' }; },
        }, async () => { asked = true; return { decision: 'keep_sandbox' }; });
        assert.equal(detected, false);
        assert.equal(asked, false);
        assert.equal(result.success, true);
    });
    await ta('回滚执行：git 模式只给命令提示，不执行 git、不改工作区', async () => {
        const prepare = async (wsDir) => {
            await fs.writeFile(path.join(wsDir, '.dacw-workspace'),
                JSON.stringify({ managedBy: '@stmcw1/dacw', version: '1.1.0' }) + '\n', 'utf8');
            const git = (args) => execFileAsync('git', args, { cwd: wsDir, windowsHide: true });
            await git(['init', '-q']);
            await git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.com', 'add', '-A']);
            await git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.com', 'commit', '-q', '-m', 'init']);
        };
        const run = await runReconWorkflow('rollback-git', 'process.exit(0);', prepare);
        assert.equal(run.result.success, true, run.result.message);
        const beforeDigest = await enumerateWorkspace(run.wsDir);
        const res = await rollbackTask(run.stateDir, run.taskId, run.wsDir, 'selftest');
        assert.equal(res.success, true, res.message);
        eq(res.mode, 'git-hint');
        eq(res.record.executed, false);
        assert.match(res.record.hint, /git reset --hard [0-9a-f]{7,40}/);
        assert.match(res.record.hint, /git clean -fd/);
        assert.match(res.message, /DACW 不执行 git 命令/);
        assert.ok(res.record.beforeFiles.length > 0, JSON.stringify(res.record.beforeFiles));
        eq(res.record.afterFiles, res.record.beforeFiles);
        // 工作区未被改动（逐文件摘要一致）
        const afterDigest = await enumerateWorkspace(run.wsDir);
        eq(Object.fromEntries(afterDigest), Object.fromEntries(beforeDigest));
        // 审计记录已写入状态文件
        const stateName = (await fs.readdir(run.stateDir)).find((name) => name.startsWith('state_'));
        const persisted = JSON.parse(await fs.readFile(path.join(run.stateDir, stateName), 'utf8'));
        eq(persisted.rollback.mode, 'git-hint');
        eq(persisted.rollback.executed, false);
        eq(persisted.status, 'NEED_HUMAN');
        eq(persisted.lastError, '已回滚，任务终止');
    });
    await ta('回滚执行：workspace 模式从备份恢复、清理新增文件、备份保留', async () => {
        const prepare = async (wsDir) => {
            await fs.writeFile(path.join(wsDir, '.dacw-workspace'),
                JSON.stringify({ managedBy: '@stmcw1/dacw', version: '1.1.0' }) + '\n', 'utf8');
            await fs.writeFile(path.join(wsDir, 'seed.txt'), 'seed\n', 'utf8');
        };
        const run = await runReconWorkflow('rollback-ws', 'process.exit(0);', prepare);
        assert.equal(run.result.success, true, run.result.message);
        assert.ok(run.result.files.includes('main.js'), JSON.stringify(run.result.files));
        const res = await rollbackTask(run.stateDir, run.taskId, run.wsDir, 'selftest');
        assert.equal(res.success, true, res.message);
        eq(res.mode, 'workspace-restore');
        eq(res.record.executed, true);
        assert.ok(res.record.beforeFiles.includes('main.js'), JSON.stringify(res.record.beforeFiles));
        const afterDigest = await enumerateWorkspace(run.wsDir);
        const afterKeys = Array.from(afterDigest.keys());
        eq(afterKeys, res.record.afterFiles);
        assert.ok(!afterKeys.includes('main.js'), '写手新增文件应被清理：' + JSON.stringify(afterKeys));
        assert.ok(afterKeys.includes('seed.txt'), JSON.stringify(afterKeys));
        assert.ok(afterKeys.includes('package.json'), JSON.stringify(afterKeys));
        // 标记文件仍在（safeCleanWorkspace 保护；捕获备份过滤它）
        const marker = await fs.readFile(path.join(run.wsDir, '.dacw-workspace'), 'utf8');
        assert.equal(JSON.parse(marker).managedBy, '@stmcw1/dacw');
        // 备份保留供审计/重试
        await fs.stat(path.join(run.stateDir, 'backup', res.record.rollbackPoint));
        // 审计记录
        const stateName = (await fs.readdir(run.stateDir)).find((name) => name.startsWith('state_'));
        const persisted = JSON.parse(await fs.readFile(path.join(run.stateDir, stateName), 'utf8'));
        eq(persisted.rollback.mode, 'workspace-restore');
        eq(persisted.rollback.executed, true);
        eq(persisted.lastError, '已回滚，任务终止');
        // 边界：无合法标记的工作区 → 拒绝回滚
        const noMarkerWs = path.join(tmpRoot, 'rollback-nomarker');
        await fs.mkdir(noMarkerWs, { recursive: true });
        const rejected = await rollbackTask(run.stateDir, run.taskId, noMarkerWs);
        eq(rejected.success, false);
        assert.match(rejected.message, /工作区无合法 DACW 标记/);
    });
    await ta('状态校验注入点：默认 null → SHA-256 跨调用可回滚；自定义函数可透传', async () => {
        eq(DEFAULT_ENGINE_OPTIONS.stateChecksumFn, null);
        eq(resolveEngineOptions(null).stateChecksumFn, null);
        const fn = (body) => 'custom:' + body.length;
        assert.equal(resolveEngineOptions({ stateChecksumFn: fn }).stateChecksumFn, fn);   // 函数按引用透传（eq 走 JSON 语义，不能用于函数）
        eq(resolveEngineOptions({ stateChecksumFn: 'not-a-function' }).stateChecksumFn, null);
        // 默认（不注入）跑任务 → rollbackTask 不带函数仍能读同一状态文件
        const prepare = async (wsDir) => {
            await fs.writeFile(path.join(wsDir, '.dacw-workspace'),
                JSON.stringify({ managedBy: '@stmcw1/dacw' }) + '\n', 'utf8');
        };
        const run = await runReconWorkflow('checksum-default', 'process.exit(0);', prepare);
        assert.equal(run.result.success, true, run.result.message);
        const res = await rollbackTask(run.stateDir, run.taskId, run.wsDir, 'selftest');
        assert.equal(res.success, true, res.message);
        eq(res.mode, 'workspace-restore');
    });
    await ta('状态校验注入：自定义 checksumFn 跨调用可读；不同函数拒绝回滚', async () => {
        const fn = (body) => 'custom:' + body.length;
        const prepare = async (wsDir) => {
            await fs.writeFile(path.join(wsDir, '.dacw-workspace'),
                JSON.stringify({ managedBy: '@stmcw1/dacw' }) + '\n', 'utf8');
            await fs.writeFile(path.join(wsDir, 'seed.txt'), 'seed\n', 'utf8');
        };
        const run = await runReconWorkflow('checksum-custom', 'process.exit(0);', prepare, null, { stateChecksumFn: fn });
        assert.equal(run.result.success, true, run.result.message);
        const ok = await rollbackTask(run.stateDir, run.taskId, run.wsDir, 'selftest', fn);
        assert.equal(ok.success, true, ok.message);
        // 状态文件确由自定义函数写入（checksum 形如 custom:<len>）
        const stateName = (await fs.readdir(run.stateDir)).find((name) => name.startsWith('state_'));
        const persisted = JSON.parse(await fs.readFile(path.join(run.stateDir, stateName), 'utf8'));
        assert.match(String(persisted.checksum), /^custom:\d+$/);
        // 换一个校验函数 → 验签失败、拒绝回滚
        const rejected = await rollbackTask(run.stateDir, run.taskId, run.wsDir, 'selftest', (body) => 'other:' + body.length);
        eq(rejected.success, false);
        assert.match(rejected.message, /状态文件校验失败/);
    });
    // ---- 工具层（plugin.apply）：dacw_rollback 注册 + 参数校验 + workspace 解析一致性 ----
    const makeDefaultHostServices = () => ({
        agentPresets: { register: async () => () => {} },
        subagents: {
            getProvider: (name) => ({ name, capabilities: { agentPreset: true } }),
            startActivation: async () => ({ childId: 'selftest-child', dispose: async () => {} }),
        },
    });
    const makePluginHarness = (rawConfig, services = {}, opts = {}) => {
        const tools = [];
        const disposers = [];
        const mergedServices = { ...makeDefaultHostServices(), ...services };
        // userQuestions 四态（B6）：confirm（默认）/ cancel / missing / error；
        // 若调用方通过 services 显式提供自定义 userQuestions（如交互请求形态 spy），则保持不动。
        const userQuestionsMode = opts.userQuestions;
        if (userQuestionsMode !== undefined) {
            if (userQuestionsMode === 'missing') delete mergedServices.userQuestions;
            else if (userQuestionsMode === 'confirm') {
                mergedServices.userQuestions = {
                    ask: async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: ['确认回滚'] }] }),
                };
            } else if (userQuestionsMode === 'cancel') {
                mergedServices.userQuestions = {
                    ask: async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: ['取消'] }] }),
                };
            } else if (userQuestionsMode === 'error') {
                mergedServices.userQuestions = {
                    ask: async () => { throw new Error('userQuestions boom'); },
                };
            } else {
                throw new Error(`unknown userQuestions mode: ${userQuestionsMode}`);
            }
        } else if (!mergedServices.userQuestions) {
            mergedServices.userQuestions = {
                ask: async ({ questions }) => ({ answers: [{ id: questions[0].id, selected: ['确认回滚'] }] }),
            };
        }
        const ctx = {
            effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
            on: () => () => {},
            get: (name) => mergedServices[name],
            // 模拟 cordis 4.x 的 ctx.inject(deps, callback)：依赖就绪后以 child ctx 回调。
            // opts.lateServices 用来模拟「激活时还没有、稍后才挂载」的服务。
            inject: (deps, callback) => {
                const childServices = { ...mergedServices, ...(opts.lateServices || {}) };
                const child = {
                    get: (name) => childServices[name],
                    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
                    on: () => () => {},
                    inject: () => ({ dispose: () => {} }),
                };
                callback(child);
                return { dispose: () => {} };
            },
            tools: {
                register: (definition) => { tools.push(definition); return () => {}; },
                restrict: () => () => {},
            },
        };
        applyPlugin(ctx, rawConfig);
        return { tools, find: (name) => tools.find((tool) => tool.name === name), disposers, services: mergedServices };
    };
    // B6：构造可回滚夹具（非 git 工作区 + 已捕获回滚点 + 一个"任务新增文件"），并读取状态文件。
    const makeRollbackFixture = async (tag) => {
        const baseDir = path.join(tmpRoot, `b6-${tag}`);
        const wsRaw = path.join(baseDir, 'ws');
        await fs.mkdir(wsRaw, { recursive: true });
        await fs.writeFile(path.join(wsRaw, '.dacw-workspace'),
            JSON.stringify({ managedBy: '@stmcw1/dacw' }) + '\n', 'utf8');
        await fs.writeFile(path.join(wsRaw, 'seed.txt'), 'seed\n', 'utf8');
        const wsDir = await fs.realpath(wsRaw);
        const stateDir = path.join(tmpRoot, `b6-${tag}-state`);
        const taskId = `b6-${tag}-task`;
        const state = new StateManager(stateDir, taskId, wsDir);
        await state.init('task');
        const point = await captureRollbackPoint(wsDir, stateDir, taskId);
        await state.update((s) => { s.rollbackPoint = point; });
        await fs.writeFile(path.join(wsDir, 'unreviewed.js'), '// new\n', 'utf8');
        const readState = async () => {
            const name = (await fs.readdir(stateDir)).find((entry) => entry.startsWith('state_'));
            return JSON.parse(await fs.readFile(path.join(stateDir, name), 'utf8'));
        };
        return { baseDir, wsDir, stateDir, taskId, readState };
    };
    await ta('宿主兼容性探测：结构性缺失 fail-fast；provider 未注册仅告警；tools.restrict 条件必需', async () => {
        const makeCtx = (tools, services, warnLogs = []) => ({
            effect: () => {},
            on: () => () => {},
            get: (name) => services[name],
            tools,
            logger: { info: () => {}, warn: (message) => warnLogs.push(message), error: () => {} },
        });
        const goodTools = { register: () => () => {}, restrict: () => () => {} };
        const assertMissing = (ctx, rawConfig, pattern) => {
            assert.throws(() => applyPlugin(ctx, rawConfig), (error) => {
                assert.match(error.message, pattern);
                assert.match(error.message, /DSH 版本可能低于 0\.2\.1-rc\.5 或 API 已变更/);
                assert.match(error.message, /请确认 DSH 版本，或联系插件维护者/);
                return true;
            });
        };
        // 1) 缺少 ctx.tools.register
        assertMissing(makeCtx(undefined, makeDefaultHostServices()), {}, /宿主不兼容：缺少 ctx\.tools\.register/);
        // 2) 默认 enforceChildToolIsolation=true 时缺少 ctx.tools.restrict
        assertMissing(makeCtx({ register: () => () => {} }, makeDefaultHostServices()), {}, /宿主不兼容：缺少 ctx\.tools\.restrict/);
        // 3) 条件性：显式关闭隔离后，同一 ctx 不再要求 restrict → 激活成功
        assert.doesNotThrow(() => applyPlugin(
            makeCtx({ register: () => () => {} }, makeDefaultHostServices()),
            { enforceChildToolIsolation: false, allowInheritedPresets: true }));
        // 4) 缺少 agentPresets.register → 不再拒绝激活（服务可能晚到）；降级为等待，并给出明确告警。
        const warn4 = [];
        assert.doesNotThrow(() => applyPlugin(
            makeCtx(goodTools, { subagents: makeDefaultHostServices().subagents }, warn4), {}));
        assert.ok(warn4.some((line) => line.includes('agentPresets')), JSON.stringify(warn4));
        // 5) 缺少 subagents.getProvider → 不再拒绝激活；由 dacw_run 运行时 fail-closed（见下方工具层用例）。
        assert.doesNotThrow(() => applyPlugin(
            makeCtx(goodTools, { agentPresets: makeDefaultHostServices().agentPresets }), {}));
        // 6) 缺少 subagents.startActivation → 不再拒绝激活；由 dacw_run 运行时 fail-closed。
        assert.doesNotThrow(() => applyPlugin(
            makeCtx(goodTools, {
                agentPresets: makeDefaultHostServices().agentPresets,
                subagents: { getProvider: () => ({ name: 'spawn' }) },
            }), {}));
        // 7) provider 未注册（getProvider 返回 undefined）→ 不拒绝激活，仅 warn（留待 dacw_run 再检查）
        const warnLogs = [];
        assert.doesNotThrow(() => applyPlugin(makeCtx(goodTools, {
            agentPresets: makeDefaultHostServices().agentPresets,
            subagents: { getProvider: () => undefined, startActivation: async () => ({}) },
        }, warnLogs), { enforceChildToolIsolation: false, allowInheritedPresets: true }));
        assert.ok(
            warnLogs.some((line) => line.includes('provider "spawn"') && line.includes('将在 dacw_run 调用时再次检查')),
            JSON.stringify(warnLogs));
    });
    await ta('运行时闸门：subagents 缺 getProvider / startActivation 时 dacw_run fail-closed', async () => {
        const missingProvider = makePluginHarness({ workspace: '' }, { subagents: {} });
        await assert.rejects(
            () => missingProvider.find('dacw_run').execute({ task: 'x' }, { agent: { id: 'a1', ctx: {} } }),
            /子代理 provider "spawn" 未注册/);
        const missingActivation = makePluginHarness({ workspace: '' }, {
            subagents: { getProvider: (name) => ({ name, capabilities: { agentPreset: true } }) },
        });
        await assert.rejects(
            () => missingActivation.find('dacw_run').execute({ task: 'x' }, { agent: { id: 'a1', ctx: {} } }),
            /缺少 startActivation/);
    });
    await ta('运行时闸门：enforceChildToolIsolation=true 且缺 agentPresets → fail-closed 并给出出路', async () => {
        const harness = makePluginHarness({ workspace: '' }, { agentPresets: undefined });
        await assert.rejects(
            () => harness.find('dacw_run').execute({ task: 'x' }, { agent: { id: 'a1', ctx: {} } }),
            (error) => {
                assert.match(error.message, /preset 不可用/);
                assert.match(error.message, /enforceChildToolIsolation: false/);
                return true;
            });
    });
    await ta('preset 延迟注册：ctx.inject 拿到晚到的 agentPresets 后注册 writer/reviewer', async () => {
        const registered = [];
        const spy = {
            register: async (definition) => { registered.push(definition.id); return () => {}; },
            resolve: async () => ({}),
        };
        makePluginHarness({}, { agentPresets: undefined }, { lateServices: { agentPresets: spy } });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(registered.slice().sort(), ['dacw-reviewer', 'dacw-writer']);
    });
    await ta('工具层：dacw_run 结果含 task_id/rollback_available；dacw_rollback git 模式端到端', async () => {
        const baseDir = path.join(tmpRoot, 'tool-git-base');
        const wsRaw = path.join(baseDir, 'ws');
        await fs.mkdir(wsRaw, { recursive: true });
        await fs.writeFile(path.join(wsRaw, '.dacw-workspace'),
            JSON.stringify({ managedBy: '@stmcw1/dacw' }) + '\n', 'utf8');
        await fs.writeFile(path.join(wsRaw, 'a.txt'), 'alpha\n', 'utf8');
        const git = (args) => execFileAsync('git', args, { cwd: wsRaw, windowsHide: true });
        await git(['init', '-q']);
        await git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.com', 'add', '-A']);
        await git(['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.com', 'commit', '-q', '-m', 'init']);
        const wsDir = await fs.realpath(wsRaw);
        const stateDir = path.join(tmpRoot, 'tool-git-state');
        const taskId = 'tool-git-task';
        const state = new StateManager(stateDir, taskId, wsDir);
        await state.init('task');
        const point = await captureRollbackPoint(wsDir, stateDir, taskId);
        eq(point.mode, 'git');
        await state.update((s) => { s.rollbackPoint = point; });
        const harness = makePluginHarness({ stateDir, workspace: '' }, {
            workingDirectory: { ensure: async () => baseDir },
        });
        const runTool = harness.find(DEFAULT_PLUGIN_CONFIG.toolName);
        const rollbackTool = harness.find('dacw_rollback');
        assert.ok(runTool && rollbackTool, JSON.stringify(harness.tools.map((tool) => tool.name)));
        // dacw_run 输出 schema 含新字段，required 覆盖
        assert.ok(runTool.output.schema.properties.task_id);
        assert.ok(runTool.output.schema.properties.rollback_available);
        assert.ok(runTool.output.schema.required.includes('task_id'));
        assert.ok(runTool.output.schema.required.includes('rollback_available'));
        const sample = {
            success: true, status: 'NEED_HUMAN', message: 'ok', workspace: wsDir,
            models: { writer: 'w', reviewer: 'r' }, round: 1, files: ['a.txt'], logs: [], elapsed_ms: 1,
            task_id: taskId, rollback_available: true,
        };
        const rendered = runTool.output.render([], sample)[0].text;
        assert.match(rendered, new RegExp(`回滚：可用（task_id: ${taskId}`));
        // 回滚工具端到端（workspace 相对 baseDir 解析，必须与建状态时一致）
        const value = await rollbackTool.execute({ task_id: taskId, workspace: 'ws', confirm: true }, { agent: { id: 'lead-agent' } });
        eq(value.success, true);
        eq(value.mode, 'git-hint');
        eq(value.task_id, taskId);
        eq(value.workspace, wsDir);
        eq(value.record.executed, false);
        assert.match(value.record.hint, /git reset --hard [0-9a-f]{7,40}/);
        assert.match(rollbackTool.output.render([], value)[0].text, /git reset --hard/);
        // git 提示模式不改工作区
        eq(await fs.readFile(path.join(wsDir, 'a.txt'), 'utf8'), 'alpha\n');
    });
    await ta('工具层：dacw_rollback workspace 模式端到端（新增文件清理、备份恢复）', async () => {
        const baseDir = path.join(tmpRoot, 'tool-ws-base');
        const wsRaw = path.join(baseDir, 'ws');
        await fs.mkdir(wsRaw, { recursive: true });
        await fs.writeFile(path.join(wsRaw, '.dacw-workspace'),
            JSON.stringify({ managedBy: '@stmcw1/dacw' }) + '\n', 'utf8');
        await fs.writeFile(path.join(wsRaw, 'seed.txt'), 'seed\n', 'utf8');
        const wsDir = await fs.realpath(wsRaw);
        const stateDir = path.join(tmpRoot, 'tool-ws-state');
        const taskId = 'tool-ws-task';
        const state = new StateManager(stateDir, taskId, wsDir);
        await state.init('task');
        const point = await captureRollbackPoint(wsDir, stateDir, taskId);
        eq(point.mode, 'workspace');
        await state.update((s) => { s.rollbackPoint = point; });
        // 模拟任务产出的新增文件
        await fs.writeFile(path.join(wsDir, 'unreviewed.js'), '// new\n', 'utf8');
        const harness = makePluginHarness({ stateDir, workspace: '' }, {
            workingDirectory: { ensure: async () => baseDir },
        });
        const rollbackTool = harness.find('dacw_rollback');
        const value = await rollbackTool.execute({ task_id: taskId, workspace: 'ws', confirm: true }, { agent: { id: 'lead-agent' } });
        eq(value.success, true);
        eq(value.mode, 'workspace-restore');
        eq(value.record.executed, true);
        // 新增文件被清理、备份内容恢复
        let newFileExists = true;
        try { await fs.access(path.join(wsDir, 'unreviewed.js')); } catch { newFileExists = false; }
        assert.equal(newFileExists, false, '任务新增文件应被清理');
        eq(await fs.readFile(path.join(wsDir, 'seed.txt'), 'utf8'), 'seed\n');
        // 审计已写入状态文件
        const stateName = (await fs.readdir(stateDir)).find((name) => name.startsWith('state_'));
        const persisted = JSON.parse(await fs.readFile(path.join(stateDir, stateName), 'utf8'));
        eq(persisted.rollback.mode, 'workspace-restore');
        eq(persisted.lastError, '已回滚，任务终止');
    });
    await ta('工具层：dacw_rollback 参数校验、找不到任务、误指无关工作区', async () => {
        const baseDir = path.join(tmpRoot, 'tool-err-base');
        const wsRaw = path.join(baseDir, 'ws');
        await fs.mkdir(wsRaw, { recursive: true });
        await fs.writeFile(path.join(wsRaw, '.dacw-workspace'),
            JSON.stringify({ managedBy: '@stmcw1/dacw' }) + '\n', 'utf8');
        const harness = makePluginHarness({}, { workingDirectory: { ensure: async () => baseDir } });
        const rollbackTool = harness.find('dacw_rollback');
        await assert.rejects(() => rollbackTool.execute({}, { agent: { id: 'lead-agent' } }), /task_id 必须是非空字符串/);
        await assert.rejects(
            () => rollbackTool.execute({ task_id: 't', reason: 'x'.repeat(501), confirm: true }, { agent: { id: 'lead-agent' } }),
            /reason 过长/);
        await assert.rejects(
            () => rollbackTool.execute({ task_id: 't', confirm: true }, { agent: null }),
            /只能由 Agent 调用/);
        // 不存在的 task_id → 抛错（不伪装成功），错误对象携带 dacwRollback
        let failure = null;
        try {
            await rollbackTool.execute({ task_id: 'no-such-task', workspace: 'ws', confirm: true }, { agent: { id: 'lead-agent' } });
        } catch (error) {
            failure = error;
        }
        assert.ok(failure, '应抛错');
        assert.match(failure.message, /回滚未成功/);
        assert.match(failure.message, /未找到任务/);
        eq(failure.dacwRollback.success, false);
        eq(failure.dacwRollback.task_id, 'no-such-task');
        // 指向无关非空目录 → prepareWorkspace 拒绝（防误回滚）
        const other = path.join(baseDir, 'other');
        await fs.mkdir(other, { recursive: true });
        await fs.writeFile(path.join(other, 'foreign.txt'), 'x\n', 'utf8');
        await assert.rejects(
            () => rollbackTool.execute({ task_id: 'x', workspace: 'other', confirm: true }, { agent: { id: 'lead-agent' } }),
            /安全拦截/);
    });
    await ta('B6-1 回滚确认：ask 返回无 answers/无 selected → fail-closed，工作区不变、rollback 未写入', async () => {
        const fixture = await makeRollbackFixture('confirm-missing');
        const digestBefore = await enumerateWorkspace(fixture.wsDir);
        const harness = makePluginHarness({ stateDir: fixture.stateDir, workspace: '' }, {
            workingDirectory: { ensure: async () => fixture.baseDir },
            userQuestions: { ask: async () => ({}) },   // 结构缺失：无 answers
        });
        const rollbackTool = harness.find('dacw_rollback');
        await assert.rejects(
            () => rollbackTool.execute({ task_id: fixture.taskId, workspace: 'ws', confirm: true }, { agent: { id: 'lead-agent' } }),
            /用户未确认回滚/);
        const digestAfter = await enumerateWorkspace(fixture.wsDir);
        eq(Object.fromEntries(digestAfter), Object.fromEntries(digestBefore));
        const persisted = await fixture.readState();
        eq(persisted.rollback, null);
        assert.ok(persisted.rollbackPoint, 'rollbackPoint 应仍在');
    });
    await ta('B6-2 回滚确认：用户选择取消 → fail-closed，工作区不变、rollback 未写入', async () => {
        const fixture = await makeRollbackFixture('cancel');
        const digestBefore = await enumerateWorkspace(fixture.wsDir);
        const harness = makePluginHarness({ stateDir: fixture.stateDir, workspace: '' }, {
            workingDirectory: { ensure: async () => fixture.baseDir },
        }, { userQuestions: 'cancel' });
        const rollbackTool = harness.find('dacw_rollback');
        await assert.rejects(
            () => rollbackTool.execute({ task_id: fixture.taskId, workspace: 'ws', confirm: true }, { agent: { id: 'lead-agent' } }),
            /用户未确认回滚/);
        const digestAfter = await enumerateWorkspace(fixture.wsDir);
        eq(Object.fromEntries(digestAfter), Object.fromEntries(digestBefore));
        eq((await fixture.readState()).rollback, null);
    });
    await ta('B6-3 回滚确认：无交互且未设置 token → fail-closed，工作区不变、rollback 未写入', async () => {
        const fixture = await makeRollbackFixture('no-token');
        const prevToken = process.env.DACW_ROLLBACK_TOKEN;
        try {
            delete process.env.DACW_ROLLBACK_TOKEN;
            const digestBefore = await enumerateWorkspace(fixture.wsDir);
            const harness = makePluginHarness({ stateDir: fixture.stateDir, workspace: '' }, {
                workingDirectory: { ensure: async () => fixture.baseDir },
            }, { userQuestions: 'missing' });
            const rollbackTool = harness.find('dacw_rollback');
            await assert.rejects(
                () => rollbackTool.execute({ task_id: fixture.taskId, workspace: 'ws', confirm: true }, { agent: { id: 'lead-agent' } }),
                /未设置 DACW_ROLLBACK_TOKEN/);
            const digestAfter = await enumerateWorkspace(fixture.wsDir);
            eq(Object.fromEntries(digestAfter), Object.fromEntries(digestBefore));
            eq((await fixture.readState()).rollback, null);
        } finally {
            if (prevToken === undefined) delete process.env.DACW_ROLLBACK_TOKEN;
            else process.env.DACW_ROLLBACK_TOKEN = prevToken;
        }
    });
    await ta('B6-4 回滚确认：交互请求形态（id/header/options/agent/signal/关键信息）', async () => {
        const fixture = await makeRollbackFixture('shape');
        let captured = null;
        const ask = async (request) => {
            captured = request;
            return { answers: [{ id: request.questions[0].id, selected: ['确认回滚'] }] };
        };
        const harness = makePluginHarness({ stateDir: fixture.stateDir, workspace: '' }, {
            workingDirectory: { ensure: async () => fixture.baseDir },
            userQuestions: { ask },
        });
        const rollbackTool = harness.find('dacw_rollback');
        const agent = { id: 'lead-agent' };
        const controller = new AbortController();
        const value = await rollbackTool.execute({ task_id: fixture.taskId, workspace: 'ws', confirm: true }, { agent, signal: controller.signal });
        eq(value.success, true);
        eq(value.mode, 'workspace-restore');
        assert.ok(captured, '应捕获交互请求');
        assert.equal(captured.agent, agent);
        assert.equal(captured.signal, controller.signal);
        eq(captured.questions.length, 1);
        const question = captured.questions[0];
        eq(question.id, 'dacw-rollback-confirm');
        eq(question.header, '确认回滚');
        eq(question.options.map((option) => option.label), ['确认回滚', '取消']);
        assert.ok(question.question.includes(fixture.taskId), question.question);
        assert.ok(question.question.includes(fixture.wsDir), question.question);
        assert.match(question.question, /回滚点/);
        // 确认后确实执行了回滚：任务新增文件被清理
        const after = await enumerateWorkspace(fixture.wsDir);
        assert.ok(!Array.from(after.keys()).includes('unreviewed.js'), JSON.stringify(Array.from(after.keys())));
    });
    await ta('B6-5 回滚确认：无交互但显式设置 DACW_ROLLBACK_TOKEN → 允许回滚（headless）', async () => {
        const fixture = await makeRollbackFixture('token');
        const prevToken = process.env.DACW_ROLLBACK_TOKEN;
        try {
            process.env.DACW_ROLLBACK_TOKEN = 'selftest-token';
            const harness = makePluginHarness({ stateDir: fixture.stateDir, workspace: '' }, {
                workingDirectory: { ensure: async () => fixture.baseDir },
            }, { userQuestions: 'missing' });
            const rollbackTool = harness.find('dacw_rollback');
            const value = await rollbackTool.execute({ task_id: fixture.taskId, workspace: 'ws', confirm: true }, { agent: { id: 'lead-agent' } });
            eq(value.success, true);
            eq(value.mode, 'workspace-restore');
            eq(value.record.executed, true);
            const after = await enumerateWorkspace(fixture.wsDir);
            assert.ok(!Array.from(after.keys()).includes('unreviewed.js'), JSON.stringify(Array.from(after.keys())));
            const persisted = await fixture.readState();
            eq(persisted.rollback.mode, 'workspace-restore');
            eq(persisted.lastError, '已回滚，任务终止');
        } finally {
            if (prevToken === undefined) delete process.env.DACW_ROLLBACK_TOKEN;
            else process.env.DACW_ROLLBACK_TOKEN = prevToken;
        }
    });
    await ta('C6-A dacw_rollback：缺 confirm 被拒，不触碰工作区、无 rollback 记录', async () => {
        const fixture = await makeRollbackFixture('confirm-required');
        const digestBefore = await enumerateWorkspace(fixture.wsDir);
        const harness = makePluginHarness({ stateDir: fixture.stateDir, workspace: '' }, {
            workingDirectory: { ensure: async () => fixture.baseDir },
        });
        const rollbackTool = harness.find('dacw_rollback');
        await assert.rejects(
            () => rollbackTool.execute({ task_id: fixture.taskId }, { agent: { id: 'lead-agent' } }),
            (error) => {
                assert.match(error.message, /请传 confirm: true/);
                assert.match(error.message, /git 工作区/);
                assert.match(error.message, /DACW_ROLLBACK_TOKEN/);
                return true;
            });
        const digestAfter = await enumerateWorkspace(fixture.wsDir);
        eq(Object.fromEntries(digestAfter), Object.fromEntries(digestBefore));
        eq((await fixture.readState()).rollback, null);
    });
    await ta('C6-B dacw_rollback：confirm 非字面量 true 一律被拒（最后防线）', async () => {
        const harness = makePluginHarness({}, {});
        const rollbackTool = harness.find('dacw_rollback');
        const exec = { agent: { id: 'lead-agent' } };
        for (const bad of [false, 'true', 1, {}, null, undefined]) {
            await assert.rejects(
                () => rollbackTool.execute({ task_id: 'some-task', confirm: bad }, exec),
                /请传 confirm: true/,
                `confirm=${String(bad)} 应被拒绝`);
        }
    });
    await ta('C6-C dacw_run：captureRollbackPoint 失败时 rollback_available=false', async () => {
        const baseDir = path.join(tmpRoot, 'c6-availability');
        const wsRaw = path.join(baseDir, 'ws');
        await fs.mkdir(wsRaw, { recursive: true });
        const wsDir = await fs.realpath(wsRaw);
        const stateDirInside = path.join(wsDir, '.state');
        const harness = makePluginHarness({
            stateDir: stateDirInside, workspace: '', allowInheritedPresets: true,
        }, {
            workingDirectory: { ensure: async () => baseDir },
        });
        const dacwRunTool = harness.find('dacw_run');
        assert.ok(dacwRunTool, 'dacw_run 应已注册');
        let failure = null;
        try {
            await dacwRunTool.execute({ task: 'selftest', workspace: wsDir }, { agent: { id: 'lead-agent' } });
        } catch (error) {
            failure = error;
        }
        assert.ok(failure, '应抛错');
        assert.ok(failure.dacw, '错误对象应含 .dacw');
        assert.equal(failure.dacw.success, false);
        assert.equal(failure.dacw.rollback_available, false, '回滚点未捕获时 rollback_available 应为 false');
        assert.match(failure.message, /回滚点|stateDir/);
    });
    await ta('敏感文件：不送模型审查、仍在交付清单、message 标注排除（F3 通过）', async () => {
        const { result, reviewerCalled, reviewerInput, logs } = await runReconWorkflow(
            'sensitive-excluded',
            'process.exit(0);',
            null,
            null,
            undefined,
            undefined,
            [
                { file: 'main.js', code: 'console.log(1);\n' },
                { file: '.env', code: 'API_KEY=SECRET_VALUE_123\n' },
            ]);
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, true);
        assert.equal(result.status, 'NEED_HUMAN');
        // D 组：敏感文件仍在交付清单，但带「敏感·未送审」后缀
        assert.ok(result.files.includes('.env（敏感·未送审）'), JSON.stringify(result.files));
        assert.ok(!result.files.includes('.env'), '敏感文件不应以裸名出现（避免看起来像已送审）');
        assert.ok(!reviewerInput.includes('SECRET_VALUE_123'), '敏感内容不应进入审查输入');
        assert.ok(!reviewerInput.includes('--- 文件: .env ---'), '敏感文件不应出现在审查输入');
        assert.match(result.message, /敏感文件未送模型审查/);
        assert.match(result.message, /\.env/);
        // D 组：finish message 行数汇总（main.js 2 行 + .env 2 行 + package.json 1 行 = 5 行）
        assert.match(result.message, /（交付 3 个文件，合计 5 行）/);
        assert.ok(logs.some((line) => line.includes('[审查排除]')), JSON.stringify(logs));
        // 审计可追溯：状态文件记录本轮被排除的敏感文件
        const stateDir = path.join(tmpRoot, 'state-recon-sensitive-excluded');
        const stateName = (await fs.readdir(stateDir)).find((name) => name.startsWith('state_'));
        const persisted = JSON.parse(await fs.readFile(path.join(stateDir, stateName), 'utf8'));
        eq(persisted.reviewExcluded, ['.env']);
        // D 组：buildManifest 条目含行数（writtenFiles 格式保持字符串清单）
        assert.match(String(persisted.writtenFiles), /main\.js \(\d+B, 2 行 sha8:[0-9a-f]{8}\)/);
        assert.match(String(persisted.writtenFiles), /\.env \(\d+B, 2 行 sha8:[0-9a-f]{8}\)/);
    });
    await ta('零送审：全部文件被敏感排除 → success:false、转人工、message 明确', async () => {
        // 删除 package.json 以构造"工作区只有敏感文件"的零送审场景（否则 package.json 会被正常送审）。
        const prepare = async (wsDir) => { await fs.rm(path.join(wsDir, 'package.json'), { force: true }); };
        const { result, reviewerCalled } = await runReconWorkflow(
            'sensitive-zero',
            'process.exit(0);',
            prepare,
            null,
            undefined,
            undefined,
            [{ file: '.env', code: 'SECRET=1\n' }]);
        assert.equal(reviewerCalled, false, '零送审不应调用审查者');
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.match(result.message, /本次无任何文件送模型审查，全部需人工确认/);
        const stateDir = path.join(tmpRoot, 'state-recon-sensitive-zero');
        const stateName = (await fs.readdir(stateDir)).find((name) => name.startsWith('state_'));
        const persisted = JSON.parse(await fs.readFile(path.join(stateDir, stateName), 'utf8'));
        eq(persisted.reviewExcluded, ['.env']);
    });
    await ta('截断 + 逃生门：截断点后的敏感文件不得被标成「未送审（审查输入上限）」', async () => {
        // 排序：a-large.js（触发总输入上限）< package.json < z-secret.pem（敏感，位于截断点之后）。
        const { result, logs } = await runReconWorkflow(
            'truncated-sensitive',
            'process.exit(0);',
            null,
            null,
            { reviewInputMaxChars: 100, allowTruncatedReview: true },
            undefined,
            [
                { file: 'a-large.js', code: 'x'.repeat(500) },
                { file: 'z-secret.pem', code: 'PRIVATE-KEY-MATERIAL\n' },
            ]);
        assert.equal(result.success, true);   // 逃生门开启：截断可放行
        // D 组：敏感文件仍交付，但带「敏感·未送审」后缀（不能标成截断/输入上限）
        assert.ok(result.files.includes('z-secret.pem（敏感·未送审）'), JSON.stringify(result.files));
        assert.equal(
            result.files.some((file) => file.startsWith('z-secret.pem（未送审') || file.startsWith('z-secret.pem（审查输入')),
            false, '敏感文件不应被标注为截断/未送审：' + JSON.stringify(result.files));
        assert.match(result.message, /敏感文件未送模型审查/);
        assert.match(result.message, /z-secret\.pem/);
        assert.match(result.message, /（交付 \d+ 个文件，合计 \d+ 行）/);
        assert.ok(logs.some((line) => line.includes('[安全降级]')), JSON.stringify(logs));
        const stateDir = path.join(tmpRoot, 'state-recon-truncated-sensitive');
        const stateName = (await fs.readdir(stateDir)).find((name) => name.startsWith('state_'));
        const persisted = JSON.parse(await fs.readFile(path.join(stateDir, stateName), 'utf8'));
        eq(persisted.reviewExcluded, ['z-secret.pem']);
    });
    await ta('秘密扫描：命中 → 本轮拒绝、feedback 含文件+类别不含原文、状态留痕', async () => {
        const apiKey = 'sk-' + 'a'.repeat(40);
        const { result, reviewerCalled, logs, writerContexts } = await runReconWorkflow(
            'secret-reject',
            'process.exit(0);',
            null,
            null,
            { maxRounds: 2 },
            undefined,
            [{ file: 'main.js', code: `const k = "${apiKey}";\n` }]);
        assert.equal(reviewerCalled, false, '命中轮次不应进入测试/审查');
        assert.equal(result.success, false);
        assert.equal(result.status, 'NEED_HUMAN');
        assert.ok(logs.some((line) => line.includes('[秘密扫描]')), JSON.stringify(logs));
        // 第二轮写手上下文应包含 feedback（文件 + 类别），且不含密钥原文
        assert.ok(writerContexts.length >= 2, JSON.stringify(writerContexts.length));
        const feedbackContext = writerContexts[1];
        assert.match(feedbackContext, /main\.js/);
        assert.match(feedbackContext, /OpenAI Key/);
        assert.ok(!feedbackContext.includes(apiKey), 'feedback 不得回显密钥原文');
        const stateDir = path.join(tmpRoot, 'state-recon-secret-reject');
        const stateName = (await fs.readdir(stateDir)).find((name) => name.startsWith('state_'));
        const rawState = await fs.readFile(path.join(stateDir, stateName), 'utf8');
        const persisted = JSON.parse(rawState);
        eq(persisted.secretScanHits, ['main.js:OpenAI Key']);
        assert.ok(!rawState.includes(apiKey), '状态文件不得记录密钥原文');
    });
    await ta('秘密扫描：sk-learn 等普通字符串不误报，正常通过', async () => {
        const { result, reviewerCalled } = await runReconWorkflow(
            'secret-no-false-positive',
            'process.exit(0);',
            null,
            null,
            undefined,
            undefined,
            [{ file: 'main.js', code: 'const s = "sk-learn";\n' }]);
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, true);
        const stateDir = path.join(tmpRoot, 'state-recon-secret-no-false-positive');
        const stateName = (await fs.readdir(stateDir)).find((name) => name.startsWith('state_'));
        const persisted = JSON.parse(await fs.readFile(path.join(stateDir, stateName), 'utf8'));
        eq(persisted.secretScanHits, null);
    });
    await ta('秘密扫描关闭：写 key 也通过，但日志【安全降级】+ 状态 lastError 留痕', async () => {
        const apiKey = 'sk-' + 'b'.repeat(40);
        const { result, reviewerCalled, logs } = await runReconWorkflow(
            'secret-scan-disabled',
            'process.exit(0);',
            null,
            null,
            { secretScanEnabled: false },
            undefined,
            [{ file: 'main.js', code: `const k = "${apiKey}";\n` }]);
        assert.equal(reviewerCalled, true);
        assert.equal(result.success, true);
        assert.ok(logs.some((line) => line.includes('安全降级') && line.includes('secretScanEnabled=false')),
            JSON.stringify(logs));
        const stateDir = path.join(tmpRoot, 'state-recon-secret-scan-disabled');
        const stateName = (await fs.readdir(stateDir)).find((name) => name.startsWith('state_'));
        const rawState = await fs.readFile(path.join(stateDir, stateName), 'utf8');
        const persisted = JSON.parse(rawState);
        assert.match(String(persisted.lastError), /secretScanEnabled=false/);
        eq(persisted.secretScanHits, null);
        assert.ok(!rawState.includes(apiKey), '状态文件不得记录密钥原文');
    });
    await ta('引擎：测试输出 key → testResult/feedback/日志均为脱敏文本（C 组）', async () => {
        const rawKey = 'sk-' + 'd'.repeat(40);
        // 假 npm：把 key 打到 stdout 后退出码 1，触发「测试失败 → feedback 含测试输出」链路。
        const scriptBody = `process.stdout.write(${JSON.stringify(rawKey)} + '\\n');\nprocess.exit(1);`;
        const { result, logs, writerContexts } = await runReconWorkflow(
            'runner-redaction',
            scriptBody,
            null,
            null,
            { maxRounds: 2 });
        assert.equal(result.success, false);
        // 状态文件 testResult 已脱敏
        const stateDir = path.join(tmpRoot, 'state-recon-runner-redaction');
        const stateName = (await fs.readdir(stateDir)).find((name) => name.startsWith('state_'));
        const rawState = await fs.readFile(path.join(stateDir, stateName), 'utf8');
        const persisted = JSON.parse(rawState);
        assert.match(String(persisted.testResult), /\[REDACTED:OpenAI Key\]/);
        assert.ok(!rawState.includes(rawKey), '状态文件不得包含密钥原文');
        // feedback（下一轮写手 system prompt）已脱敏
        assert.ok(writerContexts.length >= 2, String(writerContexts.length));
        assert.match(writerContexts[1], /\[REDACTED:OpenAI Key\]/);
        assert.ok(!writerContexts[1].includes(rawKey), 'feedback 不得包含密钥原文');
        // 日志已脱敏
        const allLogs = logs.join('\n');
        assert.match(allLogs, /\[REDACTED:OpenAI Key\]/);
        assert.ok(!allLogs.includes(rawKey), '日志不得包含密钥原文');
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
    await ta('引擎审计日志：默认 host 策略；显式 auto 走容器；显式 host 出现红色警告', async () => {
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
        assert.ok(defaultLogs.some((line) => line.includes('宿主直接执行（无隔离）')), `缺默认 host 策略提示：${JSON.stringify(defaultLogs)}`);
        assert.equal(
            defaultLogs.some((line) => line.includes('你显式配置了 sandbox.mode="host"')),
            false, '默认值不应出现红色 host 警告');
        const autoLogs = await runEngine({ sandbox: { mode: 'auto' } }, 'auto');
        assert.ok(autoLogs.some((line) => line.includes('一次性 Docker 容器')), `缺 auto 容器策略提示：${JSON.stringify(autoLogs)}`);
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
