<div align="center">

# DACW — 防御性智能体编程工作流

让 AI 写代码，让机器验代码，让人做最终裁决。

简体中文 | [English](README_EN.md) | [安全声明](SAFETY.md)

</div>

DACW 是一个 **DSH Host 插件**：写手子代理按增量协议产出代码，确定性运行机执行项目自带测试，独立审查者给出结构化裁决，最后停在人工闸门。所有失败与异常路径都收敛到 `NEED_HUMAN`，**绝不自动合入**。

## 特性

- **三权分立**：写手只产出 JSON 变更集，运行机只执行白名单命令，审查者只输出裁决——没有任何一方能独立合入代码。
- **子代理零工具隔离**：写手/审查者运行在 persona-only preset 上，插件在 `agent/created` 阶段用 `ctx.tools.restrict({ allow: [] })` 剥除全部继承工具并校验可见工具为 0；隔离失败则拒绝创建子代理。
- **沙盒默认开启（auto）**：`sandbox.mode` 默认 `"auto"`——Docker 可用时在一次性容器内执行（无网络、只读根文件系统、非 root、cap-drop ALL、资源受限）；检测到无 Docker/沙盒不可用时**不崩溃、不静默降级**，而是弹出「是否关闭沙盒」确认：选择保持或无法交互则 fail-closed 停止，确认关闭才以宿主权限执行并在结果中标注安全降级。
- **输出协议 v2**：写手只输出相对基线的变更，未提及文件逐字节保留，明显减少 token，并避免"上轮通过的代码被改坏"。
- **确定性运行机**：命令白名单（npm / pnpm / yarn / npx / node / python / python3 / pytest / cargo / go）、环境变量白名单、超时强杀、输出截断。
- **结构化审查**：裁决必须为精确 JSON，解析失败按 REJECTED 处理；PASS 但含可疑字样 → 人工闸门。
- **可配置模型**：写手/审查者可分别继承父会话路由，或从 DSH 已配置模型目录中选择；启动日志与结果对象显示实际生效的模型。
- **工作区安全闸门**：仅接受空目录或本插件写入的合法 `.dacw-workspace` 标记；拒绝系统根、用户主目录、`DSH_HOME`/profile 目录；写入前做 realpath + 逐段符号链接校验。
- **审计记录**：状态文件包含任务、文件清单摘要、测试输出与审查文本，HMAC-SHA256 签名。

> **信任边界**：测试在审查之前执行，审查是侦探性控制而非预防性控制；子代理工具隔离不是代码执行的安全边界。详见 [SAFETY.md](SAFETY.md)。

## 工作流程

```
写手（JSON 变更集） → 协调器（校验 / 合并 / 落盘） → 运行机（项目测试）
                                                        │ 失败 → 打回重写（最多 maxRounds 轮）
                                                  审查者（JSON 裁决） → 人工闸门 NEED_HUMAN
```

1. 写手按协议 v2 输出变更。
2. 协调器做路径越权校验、合并基线并把工作区重置为合并集。
3. 运行机按项目类型执行测试（每轮重新嗅探）——**这是第一次执行写手产出的代码，发生在审查之前**。
4. 审查者审计全量文件 + 地基文件（锁文件送 SHA256 摘要）。
5. 通过后返回 `success: true`、`status: "NEED_HUMAN"`；其余路径同样收敛到人工闸门。

## 安装

> **前置要求（DSH 宿主环境）**：宿主需支持 `agentPresets` 与 `subagents` 服务（`ctx.subagents` / `agentPresets`，建议使用最新版 DSH）。如果宿主版本过旧，DACW 会触发 Fail-Closed 拒绝运行，以保证隔离的安全底线：子代理必须运行在零工具 preset 上且隔离必须可验证；此外 sandbox 模式（`docker` / `auto`）无法提供容器时同样拒绝执行测试（fail-closed），不会静默回退到宿主执行。

前置：DSH 提供 `ctx.subagents`、`agentPresets` 服务与 `spawn` provider（`@deepseek-ai/dsh-subagent-spawn-in-process`）；构建需要 Node ≥ 22.13；测试默认在宿主直执（无隔离，需可用的 npm / pytest 等工具链），如需容器隔离请安装 Docker 并设置 `sandbox.mode: "docker"`/`"auto"`（sandbox 分支）；被测试项目的依赖需人工预装。

```bash
node build.mjs                              # 构建 dist/（Node 内置类型擦除，无需 typescript）
node selftest.mjs                           # 96 项回归自测
npm pack --pack-destination ../dacw-pack    # 生成安装产物
```

在 DSH 插件管理器中执行 `install_bundle`，target 填 tarball 的绝对路径并加 `file:` 前缀（例如 `file:/absolute/path/to/stmcw1-dacw-1.0.0.tgz`）。安装后向 profile 插入 Host 行 `dacw`（bundle 包名 `@stmcw1/dacw`）。**不要用目录路径安装**——目录安装会绕过 `files` 白名单，把源码、测试与构建脚本一并装进 profile。

升级：改代码 → `node build.mjs` → `npm pack` → `remove_bundle` → `install_bundle` 同一 tarball → 重启 Harness。

## 使用

模型调用 `dacw_run` 工具：

| 参数 | 必填 | 说明 |
|---|---|---|
| `task` | 是 | 需求描述（自然语言，越具体越好） |
| `workspace` | 否 | 专用工作区；绝对路径或相对会话工作目录，省略则用配置值/会话工作目录 |
| `task_id` | 否 | 审计记录文件名后缀；省略自动生成 |

成功返回：

| 字段 | 说明 |
|---|---|
| `success` / `status` | 机器闸门结果；`status` 恒为 `NEED_HUMAN` |
| `message` | 人类可读结论 |
| `workspace` / `files` / `round` | 工作区、产出文件、终止轮次 |
| `models` | `{ writer, reviewer }`，实际生效的模型 |
| `logs` / `elapsed_ms` | 日志尾部与耗时 |

启动日志示例：

```
🧠 模型配置 | ✍️ 写手: deepseek-account/deepseek-flash（插件配置） | 🔍 审查者: 继承父会话路由（DSH 默认: deepseek-account/deepseek-flash）
```

工作流失败时工具抛出错误（附工作区、状态、轮次与日志尾部），不会把失败伪装成普通结果；所有路径都不提交、不合入。

## 沙箱配置

测试执行位置由 `config.sandbox` 决定（**默认 `auto`，沙盒开启**）。Docker 不可用时系统**不会崩溃、也不会静默降级**为宿主执行，而是通过 DSH 交互确认弹出：

> 检测到当前环境无沙盒或者 Docker环境（以检测内容输出），是否关闭沙盒模式？（警告：关闭后，AI 生成的代码将直接接触宿主系统，请在确认处于安全/隔离环境时再选择关闭）

- 选择「保持沙盒」→ 取消本次运行（fail-closed，不在宿主执行任何测试代码）；
- 选择「关闭沙盒并继续」→ 本次以宿主用户权限执行，结果标注【安全降级】；
- 宿主无法弹出确认（无交互能力）→ 同样拒绝运行。

| 模式 | 行为 |
|---|---|
| `auto`（默认） | Docker 可用 → 一次性容器；不可用 → 弹出确认（见上），拒绝或无法确认则 fail-closed |
| `docker` | 强制一次性容器；Docker 不可用同样进入确认流程 |
| `host` | 显式宿主直执（无隔离，不询问；启动有红色警告，仅在你完全信任环境时使用） |

```yaml
config:
  sandbox:
    mode: auto                # auto（默认）| docker | host
    image: ''                 # 空 = 按测试命令自动选择官方镜像；也可固定如 node:22-bookworm-slim
    memoryMb: 1024
    cpus: 1                   # 允许小数
    pidsLimit: 256
    tmpfsMb: 128
```

docker 模式（sandbox 分支）的容器约束：`--network none`（无网络）、只读根文件系统（仅 /tmp tmpfs 可写）、非 root（uid/gid 1000）、`--cap-drop ALL`、`no-new-privileges`、内存 / CPU / 进程数上限、`--rm` 一次性；工作区复制进一次性暂存目录后挂载，宿主工作区本身不进入容器。首次使用请先 `docker pull` 对应镜像（node 系默认 `node:22-bookworm-slim`，python 系 `python:3.12-slim`，cargo 系 `rust:1-slim`，go 系 `golang:1.23-bookworm`）。

## 模型配置

`writerModel` / `reviewerModel` 支持四种取值：

| 取值 | 行为 |
|---|---|
| `null` / `"inherit"` | 继承父会话路由（默认） |
| `"provider/model"` | 显式指定，并校验 provider 已在 DSH 中注册 |
| `"model"` | 按模型名在 DSH 已配置模型目录中解析唯一 provider |
| `{ provider?, model, reasoningEffort? }` | 对象形式，`reasoningEffort` 透传给子代理 |

```yaml
config:
  writerModel: deepseek-account/deepseek-flash
  reviewerModel: { model: deepseek-flash, reasoningEffort: high }
```

解析发生在每次工具调用开始时，DSH 设置变更即时生效；解析失败即 fail-closed，不会静默换用其他模型。

## 安全

默认开启沙盒：Docker 可用时测试在一次性容器内执行；沙盒不可用时会弹出人类确认，选择保持或无法确认即 fail-closed 停止（不会静默降级为宿主执行）。

DACW 会执行模型生成的代码与命令。**测试在审查之前执行**，审查（含人工终审）是侦探性控制，不是执行前的安全屏障；子代理工具隔离不是代码执行的安全边界。

- 默认 `sandbox.mode: "auto"`：测试默认在一次性容器内执行；Docker 不可用时弹出人类确认，不确认则拒绝运行——不会静默降级为宿主执行。
- 用户显式确认关闭沙盒（或配置 `sandbox.mode: "host"`）时，写手产出的任意代码（含 `package.json` 的 test/pretest 脚本）将以宿主用户全权限运行，结果标注【安全降级】/红色警告；docker 模式也不是完美隔离（共享宿主内核、镜像需可信）。
- 审查完整性默认 fail-closed：审查输入被字符上限截断、或锁文件只送 SHA256 摘要时，`success` 恒为 false 并转人工；`allowTruncatedReview: true` 可显式放行（**降低安全保证**，message/files/日志会标注）。
- 请在专用或一次性环境、最小权限账号下使用，并始终保留人工终审。

完整边界、执行顺序与免责声明见 [SAFETY.md](SAFETY.md)。

## 项目结构

| 路径 | 职责 |
|---|---|
| `plugin.ts` | DSH Host 半边：工具注册、子代理 preset、运行时工具隔离、模型解析、工作区闸门 |
| `index.ts` | 协调器：轮次、基线合并、运行机调度、裁决、人工闸门 |
| `sandbox.ts` | 沙箱策略层：auto（默认）/docker/host 决策、容器参数、Docker 探测、沙盒确认请求 |
| `runner.ts` | 运行机：命令解析、超时强杀、输出截断 |
| `state_manager.ts` | 状态：原子写、HMAC、串行队列 |
| `build.mjs` / `selftest.mjs` | 构建（TS → `dist/`）与回归自测 |
| `cordis.patch.yml` / `locale/` / `icon.png` | 插件清单与展示资源 |

## 开发

- `dist/` 由 `build.mjs` 用 Node 内置类型擦除生成，不依赖 `typescript`，也不入库。
- 提交前请执行 `node build.mjs && node selftest.mjs`。
- 完整配置项与默认值见 `plugin.ts` 的 `DEFAULT_PLUGIN_CONFIG`（`cordis.patch.yml` 的 `config` 可逐项覆盖）；沙箱默认值见 `sandbox.ts` 的 `DEFAULT_SANDBOX_CONFIG`。
- 实验性项目，接口与行为可能变化。

## 状态

实验性开发者预览（当前版本 `v1.1.0`，bundle `@stmcw1/dacw`）：构建冒烟与回归自测通过。默认执行策略为宿主直执（`sandbox.mode: "host"`，无隔离）；一次性容器执行（`docker`/`auto`）在 sandbox 分支开发。v1.0.2 在 DSH `desktop` profile 的宿主执行闭环验证（写手产出 → `npm test` 通过 → 独立审查 PASS → `NEED_HUMAN`，子代理工具隔离实测生效）在默认配置下仍然成立。欢迎 issue / PR。

## 许可证

本项目基于 [MIT](LICENSE) 许可证开源。

<p align="right">npm: <code>@stmcw1/dacw</code> · <a href="https://github.com/stmcw1/DACW">GitHub</a></p>
