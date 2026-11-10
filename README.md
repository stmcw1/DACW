<div align="center">
  <a href="https://stmcw1.github.io/DACW/dacw-workflow.html" target="_blank">
    <img src="https://stmcw1.github.io/DACW/dacw.webp" alt="DACW 架构图" width="100%">
  </a>
</div>

<div align="center">

# DACW — 防御性智能体编程工作流

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm version](https://img.shields.io/npm/v/@stmcw1/dacw.svg)](https://www.npmjs.com/package/@stmcw1/dacw)
[![Node.js Version](https://img.shields.io/node/v/@stmcw1/dacw.svg)](https://nodejs.org)

让 AI 写代码，让机器验代码，让人做最终裁决。

简体中文 | [English](README_EN.md) | [安全声明](SAFETY.md)

</div>

DACW 是 **DSH Host 插件**：写手子代理按增量协议产出代码 → 确定性运行机执行项目自带测试 → 独立审查者输出 JSON 裁决 → 停在人工闸门。所有失败与异常路径都收敛到 `NEED_HUMAN`，**绝不自动合入**。

## 工作流程

```
写手 → 协调器（校验/合并/落盘）→ 运行机（项目测试）→ 审查者（JSON 裁决）→ 人工闸门
```

- 每轮把工作区重置为「基线合并集」，未提及的文件逐字节保留。
- **测试先于审查执行**：审查是事后控制（侦探性），不是执行前安全屏障；人工闸门是最终兜底。
- 测试通过后重新枚举工作区与基线对账，任何无法解释的新增/删除/内容变更 → 直接转人工，不进入审查。

## 特性

- **三权分立**：写手只输出变更集，运行机只执行白名单命令，审查者只输出裁决，任何一方都无法独立合入；隔离失败即拒绝运行（fail-closed）。
- **子代理零工具**：写手/审查者运行在 persona-only preset，创建时剥除全部宿主工具并校验可见工具为 0。
- **独立工作区**：只在你指定的目录内读写与重置（版本控制层面隔离；测试仍以宿主权限执行），闸门拒绝系统根、用户主目录与 DSH profile 目录。
- **确定性运行机**：命令/环境变量白名单、超时强杀进程树、输出截断、密钥脱敏。
- **输出协议 v2**：写手只传变更、未提及文件保留；测试后对账保证「审查对象 === 最终交付物」。
- **秘密管控三层**：敏感文件不送模型审查，写手输出凭据扫描（命中即拒绝该轮），运行机输出脱敏（`[REDACTED:<类别>]`）。
- **可配置模型**：写手/审查者独立配置，支持继承父会话/显式 `provider/model`/本地模型。
- **回滚（人工触发）**：任务开始前捕获回滚点；`dacw_rollback` 需 `confirm: true` + 人工确认（无交互宿主需 `DACW_ROLLBACK_TOKEN`）。

> **信任边界**：DACW 会执行模型生成的代码。测试在审查之前运行，审查是侦探性控制；子代理工具隔离不是代码执行的安全边界。详见 [SAFETY.md](SAFETY.md)。

## 安装

**前置要求**：DSH ≥ 0.2.2-rc.1（实测版本），宿主需提供 `ctx.subagents`、`agentPresets`、`tools` 服务；依赖 DSH 官方 `dsh-persona`、`dsh-subagent-spawn-in-process`，不依赖第三方插件。

激活时探测宿主能力，缺失即报「宿主不兼容」并拒绝激活；sandbox 与子代理隔离必须可验证，无法确认的路径一律 fail-closed。构建需要 Node ≥ 24.9；被测试项目的依赖需人工预装。

```bash
node build.mjs                              # 构建 dist/（Node 内置类型擦除，无需 typescript）
node selftest.mjs                           # 135 项回归自测
npm pack --pack-destination ../dacw-pack    # 生成安装产物
```

在 DSH 插件管理器中执行 `install_bundle`，target 填 tarball 的绝对路径并加 `file:` 前缀（例如 `file:/absolute/path/to/stmcw1-dacw-1.1.1.tgz`）。安装后向 profile 插入 Host 行 `dacw`（bundle 包名 `@stmcw1/dacw`）。**不要用目录路径安装**——会绕过 `files` 白名单，把源码、测试与构建脚本一并装进 profile。

升级：改代码 → `node build.mjs` → `npm pack` → `remove_bundle` → `install_bundle` 同一 tarball → 重启 Harness。

## 使用

模型调用 `dacw_run`：

| 参数 | 必填 | 说明 |
|---|---|---|
| `task` | 是 | 需求描述（自然语言，越具体越好） |
| `workspace` | 否 | 专用工作区；绝对路径或相对会话工作目录，省略则用配置值/会话工作目录 |
| `task_id` | 否 | 审计记录文件名后缀；省略自动生成 |

返回 `success` / `status`（恒为 `NEED_HUMAN`）/ `message` / `workspace` / `files` / `round` / `models` / `logs` / `elapsed_ms` / `task_id` / `rollback_available`。失败时工具抛错并附工作区、状态、轮次与日志尾部，不把失败伪装成普通结果；所有路径都不提交、不合入。

### 在已有项目中使用

不要把项目根目录当 workspace。推荐在项目下建空子目录：

```
your-project/
├── .dacw-work/        ← workspace，加入 .gitignore
├── src/
└── package.json
```

每轮只重置 `.dacw-work/` 内的非地基文件，项目其他文件不受影响。子目录不继承外层依赖，测试命令需指向外层工具链或预先安装；纯 Python/Go 项目同理。

> 不要手写伪造 `.dacw-workspace` 标记来绕过空目录检查：标记由插件写入，表示「本目录允许重置」，伪造等于主动让重置逻辑接管该目录。

### 回滚

`dacw_rollback` 是高影响操作：必须传 `confirm: true`（字面量），随后请求人类交互确认；宿主无交互能力时需设置 `DACW_ROLLBACK_TOKEN`，否则拒绝执行。git 工作区返回回滚指令（DACW 不执行 git 命令）；非 git 工作区从备份恢复。回滚后任务终止。

## 配置

### 测试执行位置（sandbox）

**默认 `host`：执行隔离默认关闭，测试以宿主用户权限运行写手产出的代码。**

| 模式 | 行为 |
|---|---|
| `host`（默认） | 宿主直执，无隔离；显式配置该值时启动有红色警告 |
| `auto` | Docker 可用 → 一次性容器；不可用 → 交互确认是否降级，拒绝或无法确认即 fail-closed |
| `docker` | 强制一次性容器；Docker 不可用 → 直接拒绝运行（不询问、不降级） |

docker 容器约束：无网络、只读根文件系统、非 root、`--cap-drop ALL`、`no-new-privileges`、内存/CPU/进程数上限、`--rm` 一次性；工作区先复制到一次性暂存目录再挂载。**docker 模式也不是完美隔离**（共享宿主内核，镜像需可信）。

```yaml
config:
  sandbox:
    mode: host                # host（默认）| auto | docker
    image: ''                 # 空 = 按测试命令自动选择镜像
    memoryMb: 1024
    cpus: 1
    pidsLimit: 256
    tmpfsMb: 128
```

### 写手 / 审查者模型

| 取值 | 行为 |
|---|---|
| `null` / `"inherit"` | 继承父会话路由（默认） |
| `"provider/model"` | 显式指定，并校验 provider 已注册 |
| `"model"` | 按模型名在 DSH 已配置模型目录解析唯一 provider |
| `{ provider?, model, reasoningEffort? }` | 对象形式，`reasoningEffort` 透传给子代理 |

```yaml
config:
  writerModel: deepseek-account/deepseek-flash
  reviewerModel: { model: deepseek-flash, reasoningEffort: high }
```

解析失败即 fail-closed，不会静默换用其他模型。本地模型可通过 DSH Custom model API（`@deepseek-ai/dsh-llm-pi-ai`）接入 Ollama / LM Studio / vLLM，配置成 `provider/model` 即可；本地小模型能力较弱，fail-closed 转人工会更频繁，属预期行为。

## 安全

- **默认 `host` 无隔离**：测试以宿主用户权限运行写手产出的任意代码（含 `package.json` 的 test/pretest 脚本），结果标注【安全降级】/红色警告；仅在专用或一次性环境、最小权限账号下使用。
- **审查完整性默认 fail-closed**：审查输入被截断、或锁文件仅送 SHA256 摘要时 `success` 恒为 false；`allowTruncatedReview: true` 可显式放行（**降低安全保证**，message/files/日志会标注）。
- **敏感文件不送模型审查**：按文件名识别（`.env`、`*.pem`、`*.key`、`credentials*`、`secrets*`、`id_rsa*` 等），内容不发给模型，但仍交付并保留在 `files` 清单中，需人工审阅。
- **审计边界**：状态文件与日志使用确定性 SHA-256 防意外损坏，不防同账号本地用户重算；需要强证据请导出并外部存证。
- **人工闸门是最终兜底**：PASS 但含可疑字样、审查不完整、测试后对账不一致等一律转人工。

完整边界、执行顺序与免责声明见 [SAFETY.md](SAFETY.md)；已知限制见 [ROADMAP.md](ROADMAP.md)「4b」。

## 开发

```bash
node build.mjs        # dist/ 用 Node 内置类型擦除生成，不依赖 typescript，不入库
node selftest.mjs     # 提交前请执行 build + selftest
```

项目结构：`plugin.ts`（Host 半边）、`index.ts`（协调器）、`runner.ts`（运行机）、`sandbox.ts`（沙箱策略）、`secrets.ts`（秘密检测/脱敏）、`state_manager.ts`（状态）。图示见 [docs/dacw-workflow.html](docs/dacw-workflow.html)。完整配置默认值见 `plugin.ts` 的 `DEFAULT_PLUGIN_CONFIG` 与 `sandbox.ts` 的 `DEFAULT_SANDBOX_CONFIG`（`cordis.patch.yml` 可逐项覆盖）。实验性项目，接口与行为可能变化。

## 状态

实验性开发者预览（当前发布版本 `v1.1.1`，bundle `@stmcw1/dacw`）：构建冒烟与 135 项回归自测通过；`v1.1.1` 修复回滚后地基文件残留（兼容 1.1.0 旧 state）。默认执行隔离关闭（`host`）。已知限制见 [ROADMAP.md](ROADMAP.md)「4b」。`2.0.0`（engine 重构）在计划中。

## 许可证

本项目基于 [MIT](LICENSE) 许可证开源。

<p align="right">npm: <code>@stmcw1/dacw</code> · <a href="https://github.com/stmcw1/DACW">GitHub</a></p>
