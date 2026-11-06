## DACW engine 重构路线表

原则：**先立契约，再抽 Step，最后换主干。** 每一步可独立合并、独立回滚，不搞大爆炸式重写。

### 阶段总览

| 阶段 | 目标 | 产出 | 依赖 | 风险 |
|---|---|---|---|---|
| P0 | 冻结契约 | `types.ts`：`IDacwContext` / `PipelineState` / `Step` / `State` / `Event` / `StepResult` | 无 | 接口定错，后面全改 |
| P1 | 封装 StateManager | `getStateByTaskId()` / `saveTransition()` / 两阶段写 | P0 | 旧 state file 兼容 |
| P2 | 抽 Step（不改主干） | `steps/*.ts`，每个 Step 包住现有 `apply()` 的一段逻辑 | P0、P1 | Step 之间还在共享闭包变量 |
| P3 | 建迁移表 + 瘦主干 | `state_machine.ts` + `pipeline.ts`（≤50 行），替换 `engine.apply()` | P2 | 非法迁移暴露旧代码的隐式分支 |
| P4 | 测试补齐 | 表驱动测试 + Step 单测 + 非法迁移 + 终态用例 | P3 | 覆盖率虚高，Step 内部逻辑没测 |
| P5 | 旁路事件 + 并发锁 | `emitTransition()`（不影响控制流）；`O_EXCL` 跨进程锁 | P3 | 事件订阅者抛错中断主流程 |

**串行：P0 → P1 → P2 → P3。P4 可与 P3 并行起步。P5 在 P3 后独立做。**

---

### 逐阶段落地

#### P0：冻结契约（必须最先做）

| 项 | 内容 |
|---|---|
| 文件 | `types.ts` |
| 内容 | `Step.execute(ctx) => StepResult`，`StepResult` 含 `output` / `reasonCode`；`State` 枚举；`Event` 枚举；`TRANSITIONS` 类型 |
| 约束 | Step 禁止写 state、禁止设 `nextState`；`reasonCode` 必填于 `need_human` / `abort` |
| 验收 | 类型编译通过；`selftest.mjs` 加一条「非法 StepResult 被类型拒绝」的编译期用例 |
| 不做 | 不碰 `index.ts` 任何逻辑 |

**为什么先做：** 没有契约，P2 抽出来的 Step 会各写各的返回值，P3 迁移表对不上。

---

#### P1：封装 StateManager

| 项 | 内容 |
|---|---|
| 文件 | `state_manager.ts` |
| 新增 | `currentState`、`phase: 'idle' \| 'running'`、`round`、`rollback` 字段 |
| API | `getStateByTaskId(taskId)`；`saveRunning(taskId, state)`；`saveTransition(taskId, from, event, to, output)` |
| 移除 | 外部 `readdir` + `state_*` 前缀匹配（外部只调 API） |
| 兼容 | 旧 state file 无 `currentState` → 按 `NEED_HUMAN` 处理，不自动恢复 |
| 验收 | 单测：两阶段写原子性；旧文件迁移；`getStateByTaskId` 不泄露文件名规则 |

**为什么第二：** P2 的 Step 要读写状态，必须先有稳定 API，否则 Step 又会直接碰文件。

---

#### P2：抽 Step（不改主干行为）

| 项 | 内容 |
|---|---|
| 文件 | `steps/secret_scan.ts`、`sandbox_check.ts`、`generate.ts`、`merge.ts`、`pre_test_snapshot.ts`、`test.ts`、`reconcile.ts`、`review.ts`、`human_gate.ts` |
| 做法 | 每个 Step 包住 `apply()` 里对应一段逻辑；`apply()` 改为依次调用 Step，**行为逐字节不变** |
| 约束 | Step 只通过 `ctx` 拿输入，`output` 返回产出；不读模块级闭包变量 |
| 验收 | 现有 128 项 selftest 全绿；每个 Step 至少一条独立单测 |
| 风险 | `apply()` 里有共享局部变量 → 必须显式搬进 `PipelineState`，否则 Step 间隐式耦合 |

**为什么先抽 Step 再换主干：** 一步到位改主干 + 抽 Step，出问题无法定位是 Step 错还是路由错。

---

#### P3：迁移表 + 瘦主干

| 项 | 内容 |
|---|---|
| 文件 | `state_machine.ts`（`TRANSITIONS`）、`pipeline.ts`（`runStateMachine`） |
| 主干 | 查 Step 注册表 → `step.run(ctx)` → 结果转 Event → 查迁移表 → 写 `saveTransition` → 循环 |
| 非法迁移 | 抛 `IllegalTransitionError`，直接 `NEED_HUMAN`，不继续 |
| 回边 | 若保留「REJECTED → 重写」，迁移表写 `maxRounds`，超限转 `NEED_HUMAN` |
| 终态 | `NEED_HUMAN` / `ABORTED` 无出边，任何 Step 调用被拒 |
| 删除 | `engine.apply()` 原长函数 |
| 验收 | 主干 ≤ 50 行；128 项 selftest 全绿；新增非法迁移用例 |

**这是唯一一次「改主干」的提交，独立 PR，便于回滚。**

---

#### P4：测试补齐

| 测试 | 内容 |
|---|---|
| 表驱动 | Mock 全部 Step，遍历 `TRANSITIONS` 每条边，断言路由正确 |
| 非法迁移 | Step 返回表外组合 → 断言 `IllegalTransitionError` + `NEED_HUMAN` |
| 终态 | 从 `NEED_HUMAN` / `ABORTED` 起步 → 断言拒绝 |
| Step 单测 | Mock `ctx` + `StateManager`，断言 `output` 内容 + `reasonCode` |
| 崩溃恢复 | `phase: 'running'` 重启 → 断言转 `NEED_HUMAN`，不重跑 |

---

#### P5：旁路事件 + 并发锁

| 项 | 内容 |
|---|---|
| 事件 | `emitTransition(from, event, to)` 仅审计/UI/指标；订阅者抛错被捕获，不中断主干 |
| 并发锁 | `O_EXCL` 锁文件，跨进程保护同一工作区；`workspaceLocks` 保留进程内串行 |
| 验收 | 订阅者故意抛错，主流程仍走完；两进程并发同工作区，一方 fail-closed |

---

### 明确不做 / 延后

| 项 | 原因 |
|---|---|
| 完整事件驱动主流程 | 与 fail-closed、确定性审计冲突 |
| `phase: 'running'` 自动重跑 | 非幂等 Step 会半应用叠加；仅幂等 Step 可声明后重跑，列入后续 |
| 配置任务级快照 | 属 ROADMAP §4，重构期间不混入 |
| 对账规则重构 | 独立模块，可并行但不在本路线关键路径 |

---

### 一句话优先级

**P0 契约 → P1 StateManager → P2 抽 Step（行为不变）→ P3 换主干 → P4 补测 → P5 旁路与锁。** 每个阶段独立 PR、独立回滚；P2 之前不碰主干，P3 之前不改行为。