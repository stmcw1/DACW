DACW engine 重构路线图 v10
版本策略：

版本	性质	内容
1.1.1	patch	修地基文件残留，保 1.1.0 兼容（semver 强制，不是迁就）
2.0.0	major	重构，不保 1.x state 兼容
2.1.0	minor	MVP-2 从干净格式起步
前置原则：先立契约，再抽 Step，最后换主干。P2 之前不碰主干，P3 之前不改行为。

0. 开工前置
#	动作	产出	阻塞谁
0.1	1.1.1 代码改动，单一 PR 提交	1.1.1 PR	P0（2.0.0 重构开工）
0.3	P0 PR 描述引用 §1 作为执行规则依据	PR 留痕	P0 合入
1.1.1 先做，P0 在 1.1.1 合入后开工（串行）。 理由：1.1.1 是约束源，它的实际实现（RollbackPoint 字段名、listRootFoundationFiles 行为）是 2.0.0 的 P1 的对齐对象。

0.1 指令（1.1.1，最简版）
改动只有四件事：

RollbackPoint 加字段：foundationAtStart?: string[]

位置：RollbackPoint 内部（语义干净，不在 WorkflowState 顶层）

不新增 WorkflowState 顶层字段

captureRollbackPoint 记录

workspace 模式：捕获回滚点时，调用 listRootFoundationFiles(workspaceDir)，结果写入 rollbackPoint.foundationAtStart

空工作区显式 []（不是 undefined）——三态区分的关键

git 模式：不记录，保持 undefined

旧 state（1.1.0）：键缺失 → undefined

rollbackTask 三态清理

rollbackPoint.foundationAtStart	判定	行为
undefined	旧 state 或 git 模式	跳过地基清理（保持 1.1.0 行为）
[]	新 state 空工作区	清理所有地基文件
["package.json", ...]	新 state 有地基文件	清理不在列表里的地基文件
三态靠 Array.isArray + 长度区分，不靠「键缺失 vs undefined」——因为默认值已改为 []，键缺失只出现在旧 state。

selftest.mjs 用例

空工作区 → foundationAtStart === [] → 回滚清理写手新增的 package.json

有 package.json 的工作区 → foundationAtStart === ["package.json"] → 回滚保留 package.json

git 模式 → foundationAtStart === undefined → 跳过

1.1.0 旧 state → foundationAtStart === undefined → 跳过（构造方式见下）

1.1.0 旧 state 的构造方式（第四种场景用）：

手工构造 JSON，不建 fixture 文件（1.1.1 是 patch，不引入 test-fixtures/ 目录；2.0.0 的 P1 才建）。

字段集合 = 1.1.0 的 WorkflowState 字段（version: 1、taskId、taskPrompt、round、status、writtenFiles、testResult、reviewResult、reviewExcluded、secretScanHits、rollbackPoint、rollback、lastError），其中 rollbackPoint 不含 foundationAtStart 键。checksum 是文件级字段（不属于 WorkflowState 接口），单独写入文件。

构造后：

用 1.1.1 的 StateManager 算出全字段 SHA256（1.1.1 checksum 算法与 1.1.0 一致，因此与 1.1.0 算法结果相同），写回文件的 checksum 键

调用 rollbackTask，断言 res.success === true

断言回滚后工作区地基文件未被清理（rollbackPoint.foundationAtStart === undefined → 跳过）

实现依赖：StateManager 需暴露可调用方式算 checksum（如 StateManager.computeChecksum(state) 静态方法或内部导出）。若实现时发现没有此能力，按 §1 第 1 类（tsc 可暴露）进代码修。

checksum：不动。 保持全字段 SHA256，1.1.1 与 1.1.0 算法一致，旧 state 天然可读。

不需要的东西（相比方案二全部删除）：

❌ CHECKSUM_BUSINESS_FIELDS 导出常量

❌ A1 顶层/嵌套规则

❌ 两个 fixture

❌ SAFETY.md 披露

❌ listRootFoundationFiles 之外的 helper

listRootFoundationFiles 放 index.ts，显式排除 .git / node_modules / .dacw-workspace，其余按 isFoundationName 判定。返回根级地基文件名列表，只包含文件，不包含目录。

1. 执行规则
0. 遇到「A 要配合 B」的耦合问题，先列约束链，不画全貌。 约束链分段走（A→B 一段、B→A 一段），每段中间状态显式合法；全貌留到代码里验证。

后续任何阶段发现 v10 未预见的矛盾，按以下规则处理：

进代码修，不改文档（三条任一成立）：

矛盾能用 tsc 直接暴露（类型层）

矛盾是「两个字段哪个是事实来源」（运行时层，代码逼你选）

矛盾是「一条规则和已有 5 条以上规则的交叉」（组合爆炸，纸面推不出）

改文档：只有「一条规则和另一条规则的简单直接碰撞」才值得回改 v10。

进代码修时必须留痕（PR 描述三行）：遇到什么矛盾、为什么选这个解法、有没有改变 v10 契约语义。

P0 PR 描述必须声明：本次 P0 实现中若遇 v10 未预见矛盾，按 §1 判定并留痕于本 PR 描述。

2. 阶段总览
阶段	目标	产出	依赖	风险
P0	冻结契约	types.ts + 三条 tsc 验证	0.1	接口定错，后面全改
P1	StateManager 封装（2.0.0 干净起步）	state_manager.ts 重定义	P0	WorkflowState 结构设计
P2	抽文件层 + 抽 Step（行为不变）	workspace_fs.ts、rollback.ts、marker.ts、steps/*.ts	P0	Step 间隐式共享变量；import 图变化
P3	迁移表 + 瘦主干	state_machine.ts、pipeline.ts（≤50 行）	P1、P2	非法迁移暴露隐式分支
P4	测试补齐	表驱动 + Step 单测 + 边界用例	P3	覆盖率虚高
P5	旁路事件 + 跨进程锁	emitTransition()、O_EXCL	P3	订阅者抛错中断主干
串行 0.1 → P0 → P1 → P2 → P3；P4 与 P3 并行起步；P5 独立。

3. P0：冻结契约
产出：types.ts + 三条 tsc 验证通过。

3.1 契约定义
ts
// —— 枚举 ——
type State = 'INIT' | 'SANDBOX_CHECK' | 'CAPTURE_ROLLBACK' | 'GENERATE'
  | 'MERGE' | 'PRE_TEST_SNAPSHOT' | 'TEST' | 'RECONCILE' | 'REVIEW'
  | 'HUMAN_GATE' | 'NEED_HUMAN';
// 注意：无 'ABORTED'。用户取消走 ReasonCode.ABORTED → NEED_HUMAN。

type ReasonCode = 'OK' | 'WRITER_FAILED' | 'PARSE_FAILED' | 'SECRET_HIT'
  | 'TEST_FAILED' | 'REJECTED' | 'REVIEWER_FAILED' | 'REVIEW_INCOMPLETE'
  | 'ZERO_REVIEW' | 'REVIEW_READ_FAILED' | 'SUSPICIOUS_SIGNAL'
  | 'RECONCILE_FAILED' | 'REVALIDATION_FAILED' | 'SNAPSHOT_FAILED'
  | 'ROLLBACK_CAPTURE_FAILED' | 'SANDBOX_BLOCKED' | 'ABORTED' | 'FATAL';

// —— PipelineState ——
interface PipelineState {
  baseFiles: ReadonlyMap<string, string>;   // ReadonlyMap 非 Map
  finalFiles: string[] | null;
  sandboxPlan: ExecutionPolicy;             // 只读引用
  runner: Runner;                           // 只读引用
  rollbackPointCaptured: boolean;
  sandboxDisabledByConsent: boolean;
  resultMessage: string | null;
  success: boolean;
}
// 注意：PipelineState 无 feedback 字段。feedback 唯一事实来源是 WorkflowState.feedback。

// —— StepOutput（P0 起步用写法 A）——
type OutputKey = Exclude<keyof PipelineState, 'success' | 'resultMessage'>;
type StepOutput = Partial<Pick<PipelineState, OutputKey>>;

// —— StepContext / StepResult ——
interface StepContext {
  currentState: State;
  taskId: string;
  workspaceDir: string;
  stateManager: StateManager;
  sandboxPlan: ExecutionPolicy;
  round: number;
  feedback: string | null;                  // 只读快照，来自 WorkflowState.feedback
  pipelineState: Readonly<PipelineState>;
}

interface StepResult {
  output: StepOutput;
  diagnostics?: Record<string, unknown>;    // 独立通道，不进 PipelineState，只进审计
  feedback?: string;                        // 跨轮反馈出口，pipeline 剥离后写 WorkflowState.feedback
  reasonCode: ReasonCode;
  success: boolean;                         // 仅 HUMAN_GATE + OK 为 true
}
feedback 对称关系（P0 契约注释必须写明）：

入：StepContext.feedback ← WorkflowState.feedback 只读快照

出：StepResult.feedback → pipeline 剥离后写 WorkflowState.feedback

禁止把 feedback 塞进 PipelineState

3.2 语义约束
项	规则
success	只有 HUMAN_GATE + OK 是 true。pipeline 断言校验。
diagnostics	自由键，不进 PipelineState，原样写入 WorkflowState.stepDiagnostics。FATAL / SNAPSHOT_FAILED 子因写 diagnostics.detail，不写 output.detail。
feedback	StepResult 顶层字段，不在 StepOutput 内。pipeline 剥离后写 WorkflowState.feedback，不进 PipelineState。
output 禁写键	success 恒禁；resultMessage 仅 HUMAN_GATE 允许。
对象字段只读	runner / sandboxPlan / baseFiles 内部状态禁止 Step 修改；需替换时 output 返回新对象。
Step 异常边界	已知失败自 catch 转 reasonCode；未预期异常冒泡到 pipeline。Step 内不得吞掉未预期异常后自行编 reasonCode。
WorkflowState 字段（2.0.0 重新设计）	version: 2、taskId、taskPrompt、round、status、writtenFiles、testResult、reviewResult、reviewExcluded、secretScanHits、rollbackPoint（含 foundationAtStart?: string[]）、rollback、lastError、currentState、phase: 'idle' | 'running' | 'terminal'、feedback: string | null、stepDiagnostics?: Record<string, unknown> | null、corruptionFlags?: string[]（@transient，不落盘）
version: 2 是 2.0.0 的显式标记。2.0.0 的 load() 遇到 version !== 2 → 明确报错「1.x state 不兼容」。

3.3 三条 tsc 验证（P0 合入前必须全过）
验证 1：ReadonlyMap 拦 .set()

ts
type PS = { baseFiles: ReadonlyMap<string, string> };
declare const ps: PS;
ps.baseFiles.set('x', 'y');  // 期望：tsc 报错 Property 'set' does not exist
验证 2：StepOutput 写法 A 编译

ts
type OutputKey = Exclude<keyof PipelineState, 'success' | 'resultMessage'>;
type StepOutput = Partial<Pick<PipelineState, OutputKey>>;
编译过 → 成立

编译不过 → 改写法 B（显式白名单），不改文档

编译过但越界键能写进去 → P3 mergeAndRebuild 运行时兜底，不改文档

验证 3：diagnostics / feedback 不参与 OutputKey 推导

二者必须是 StepResult 平级字段；若混入 OutputKey → 改 types.ts

3.4 P0 验收
三条 tsc --noEmit 全过

selftest 加：① 非法 StepResult 被类型拒绝；② success 与 (state, reasonCode) 不一致时 pipeline 断言拒绝；③ diagnostics / result.feedback 写任意键不触发 IllegalStepOutputError

不碰 index.ts

PR 描述引用 §1 并声明执行规则

4. P1：StateManager 封装（2.0.0 干净起步）
产出：state_manager.ts 重定义。

4.1 核心原则
2.0.0 不保 1.x state 兼容。 这是 major 的正当权利，也是重构能干净落地的关键。

checksum：全字段 SHA256（沿用 1.x 算法，但不承诺读 1.x state）

WorkflowState.version: 2：显式标记

load() 遇到 version !== 2 或 checksum 不匹配 → 明确报错，不尝试迁移

报错文案：

检测到 1.x 版本的 state 文件（version=X 或 checksum 不匹配）。DACW 2.0.0 不兼容 1.x state，旧任务无法回滚。请使用 2.0.0 重新运行任务。

4.2 corruptionFlags 不落盘
update() 写盘时强制剔除

load() 每次重新计算，不信任文件里的值

State 接口标 @transient

4.3 load() 语义
纯读，不自动写盘

返回的 state 可带 corruptionFlags

version !== 2 → 抛错（1.x state 不兼容）

currentState 缺失或非枚举 → corruptionFlags

phase 非 'idle' \| 'running' \| 'terminal' → corruptionFlags

rollbackPoint.foundationAtStart 存在但非数组 → corruptionFlags（冗余防御，主要防线是 checksum）

4.4 API
ts
class StateManager {
  constructor(stateDir, rawTaskId, workspaceDir, checksumFn?)
  async init(taskPrompt): Promise<void>
  async load(): Promise<State | null>                            // version !== 2 抛错
  async update(fn: (s: State) => void): Promise<void>            // 写盘剔除 corruptionFlags

  async saveRunning(state: Partial<State>): Promise<void>
  async saveTransition(from: State, reasonCode: ReasonCode,
                       to: State, output: Record<string, unknown>): Promise<void>

  static async getStateByTaskId(stateDir, rawTaskId, workspaceDir, checksumFn?): Promise<State | null>
}
getStateByTaskId 静态工厂，返回 null 表示无记录

禁止外部 readdir + state_* 前缀匹配

checksumFn 只在构造时注入一次；runWorkflow 与 rollbackTask 共用同一来源

4.5 P1 验收
① 2.0.0 新 state 的 load() 成功

② rollbackTask 对新 state 成功

③ 1.x state（手工构造 version: 1）→ load() 抛错「1.x state 不兼容」

④ checksumFn 单点注入断言

⑤ 两阶段写原子性单测

⑥ currentState: "BOGUS" → load() 成功带 flags

⑦ phase: "weird" → 同理

⑧ update() 后文件不含 corruptionFlags

⑨ 连续两次 load() 对 BOGUS 幂等返回 flags

⑩ flags 非空 → 写 NEED_HUMAN → 再 load() flags 为空（循环破除）

⑪ rollbackPoint.foundationAtStart: "not-an-array" → flags（checksum 已兜底，此为冗余）

5. P2：抽文件层 + 抽 Step（行为逐字节不变）
5.1 P2a：抽文件层（纯搬移）
新文件	搬出内容
workspace_fs.ts	safeWriteFile / safeReadForReview / safeReadBufferForReview / safeCleanWorkspace / enumerateWorkspace / fingerprintProtectedDirs / diffDigest / resolveInsideWorkspaceReal / assertNoSymlinkAncestors / listRootFoundationFiles / isFoundationName
rollback.ts	captureRollbackPoint / rollbackTask / RollbackResult / RollbackBeforeExecute
marker.ts	isValidWorkspaceMarker / WORKSPACE_MARKER_MANAGED_BY / LEGACY_WORKSPACE_MARKER_MANAGED_BY
import 图硬约束：marker.ts 唯一定义；workspace_fs.ts 与 rollback.ts 互不 import；index.ts 保留 re-export；plugin.ts import 改到新文件。

listRootFoundationFiles 的 P2a 归属（P2a PR 描述必须决定并留痕）：

1.1.1 中 listRootFoundationFiles 放 index.ts。P2a 把 captureRollbackPoint 搬到 rollback.ts 时，有两种归属：

选项 A：随 captureRollbackPoint 一起搬进 rollback.ts。rollback.ts 内部使用，不 export。

选项 B（推荐）：搬进 workspace_fs.ts（本质是文件系统操作，与 enumerateWorkspace 同类）。rollback.ts 从 workspace_fs.ts import。

禁止保留在 index.ts——index.ts re-export rollback.ts 的 captureRollbackPoint，rollback.ts 反向 import index.ts 会循环依赖。

推荐 B 的理由：listRootFoundationFiles 是根级 readdir + isFoundationName 过滤，语义上与 enumerateWorkspace（递归枚举）同族，放 workspace_fs.ts 一致。isFoundationName 一并搬入 workspace_fs.ts。

P2a PR 描述必须写：选了 A 还是 B、理由、isFoundationName 的最终位置。

P2a 验收：node build.mjs && node selftest.mjs 全绿；Object.keys(await import('./dist/index.js')) 与搬移前快照一致；plugin.ts 从 dist 正常加载。

5.2 P2b：抽 Step
文件	reasonCode 映射
steps/sandbox_check.ts	OK / SANDBOX_BLOCKED
steps/capture_rollback.ts	OK / ROLLBACK_CAPTURE_FAILED
steps/generate.ts	OK / WRITER_FAILED / PARSE_FAILED / ABORTED
steps/secret_scan.ts	OK / SECRET_HIT
steps/merge.ts	OK / FATAL
steps/pre_test_snapshot.ts	OK / SNAPSHOT_FAILED
steps/test.ts	OK / TEST_FAILED
steps/reconcile.ts	OK / RECONCILE_FAILED
steps/review.ts	OK / REVIEWER_FAILED / REJECTED / REVIEW_INCOMPLETE / ZERO_REVIEW / REVIEW_READ_FAILED / SUSPICIOUS_SIGNAL / ABORTED
steps/human_gate.ts	OK / REVALIDATION_FAILED
Step 约束：只通过 ctx 拿输入，禁止读模块级闭包变量；feedback 只写 StepResult.feedback（顶层），不写 output；诊断信息写 StepResult.diagnostics.detail，不写 output.detail；不修改 ctx.pipelineState 对象内部状态；已知失败自 catch 转 reasonCode，未预期异常不吞。

P2b 验收：131 项 selftest 全绿；每 Step 至少一条独立单测；P2 结束 apply() 行为与重构前逐字节一致；diagnostics.detail / result.feedback 不被拒绝。

已知行为（重构保持不变）：merge 失败走 FATAL 不回边。

6. P3：迁移表 + 瘦主干
6.1 主干伪码
text
runStateMachine(ctx):
  lock(workspaceDir)
  try:
    state = load() or INIT
    if state.corruptionFlags?.length:
      state.currentState = NEED_HUMAN
      pipelineState.success = false
      pipelineState.resultMessage = "状态文件损坏（flags: " + flags.join(", ") + "），需人工介入"
      break
    rewriteCount = 0
    loop:
      step = registry[state.currentState]
      if step == null: throw IllegalTransitionError("terminal or unknown state")
      view = snapshotView(pipelineState)
      result = step.execute({ ...ctx, feedback: state.feedback, pipelineState: view })

      if result.success != (state.currentState == HUMAN_GATE && result.reasonCode == OK):
        throw new IllegalStepResultError(...)

      saveRunning(convertToWorkflowState(result.output))
      if result.diagnostics !== undefined:
        state.stepDiagnostics = result.diagnostics
      if result.feedback !== undefined:
        state.feedback = result.feedback
      pipelineState = mergeAndRebuild(pipelineState, result.output)
      pipelineState.success = result.success

      candidate = TRANSITIONS[(state.currentState, result.reasonCode)]
      if candidate == null: throw IllegalTransitionError(...)
      if candidate == GENERATE:
        if rewriteCount >= maxRounds - 1:
          candidate = NEED_HUMAN
          pipelineState.resultMessage = "达到最大轮次 (" + maxRounds + ")，需人工介入"
        else:
          rewriteCount += 1
      saveTransition(state.currentState, result.reasonCode, candidate, result.output)
      state.currentState = candidate
      if candidate == NEED_HUMAN: break
  catch (e):
    writeFATAL(state.currentState, e)
    state.currentState = NEED_HUMAN
    pipelineState.success = false
    pipelineState.resultMessage = "工作流异常终止：" + (e?.message ?? String(e))
  finally:
    unlock(workspaceDir)
convertToWorkflowState(output: StepOutput): Partial<WorkflowState>
键集合不重叠：PipelineState 和 WorkflowState 的键没有同名项，不存在「同名直传」。转换规则：

StepOutput 键	转换	写入 WorkflowState
baseFiles	buildManifest(baseFiles, manifestMaxEntries)	writtenFiles
finalFiles	不持久化	—
runner	不持久化	—
sandboxPlan	不持久化	—
rollbackPointCaptured	不持久化	—
sandboxDisabledByConsent	不持久化	—
resultMessage	不持久化（在 pipelineState 中，由 executeTask 返回）	—
success	不持久化（同上）	—
原则：saveRunning 只持久化需要跨进程/崩溃恢复的数据。运行时状态（runner / sandboxPlan / finalFiles / resultMessage / success）留在 pipelineState，不写 state 文件。

round / status / currentState / feedback / stepDiagnostics 由 pipeline 在其他位置显式写入（state.currentState = candidate、state.feedback = result.feedback 等），不经过 convertToWorkflowState。

PR 描述必须记录：哪些键持久化、哪些不持久化、为什么（崩溃恢复需要 vs 运行时状态）。

6.2 关键规则
项	规则
snapshotView	浅拷贝 pipelineState 全部键，Readonly<> 只保护顶层；对象字段共享引用，契约要求 Step 不改内部状态
mergeAndRebuild	① 逐键校验 result.output 键 ∈ PipelineState 已知键；② 校验不含 success / resultMessage（resultMessage 仅 HUMAN_GATE 允许）；③ 不校验 diagnostics 键；④ 不校验 feedback 键；⑤ 违反 → IllegalStepOutputError；⑥ 通过 → 浅拷贝新对象
feedback 单源	state.feedback 是事实来源；每轮 ctx.feedback = state.feedback；Step 写 result.feedback（顶层）时 pipeline 直接写 state.feedback，不进入 pipelineState
diagnostics	写 state.stepDiagnostics（覆盖写，不累积），不进 pipelineState
失败路径 resultMessage	三条路径显式赋值：corruptionFlags / rewriteCount 耗尽 / catch。null 视为 pipeline 实现缺陷
内部异常	IllegalStepOutputError / IllegalStepResultError 是 pipeline 内部类型，不属 ReasonCode；catch 转 FATAL，diagnostics.detail 写描述。P4 期望 FATAL + NEED_HUMAN，不期望异常类型本身
回边计数	rewriteCount，首次进入 GENERATE 不加，只有回边 +1；>= maxRounds - 1 时拦截
saveRunning 参数转换	按上方 convertToWorkflowState 显式映射表。PR 描述留痕
锁链	workspaceLocks 移入 pipeline.ts 外层；P5 加 O_EXCL，两层并存；P3 不得删除
6.3 完整迁移表
推进边（OK）

From	To
INIT	SANDBOX_CHECK
SANDBOX_CHECK	CAPTURE_ROLLBACK
CAPTURE_ROLLBACK	GENERATE
GENERATE	MERGE
MERGE	PRE_TEST_SNAPSHOT
PRE_TEST_SNAPSHOT	TEST
TEST	RECONCILE
RECONCILE	REVIEW
REVIEW	HUMAN_GATE
HUMAN_GATE	NEED_HUMAN（唯一 success:true）
回边（→ GENERATE，受 rewriteCount 限流）

From	ReasonCode
GENERATE	WRITER_FAILED / PARSE_FAILED / SECRET_HIT
TEST	TEST_FAILED
REVIEW	REVIEWER_FAILED / REJECTED
终态边（→ NEED_HUMAN，不回边）

From	ReasonCode
SANDBOX_CHECK	SANDBOX_BLOCKED
CAPTURE_ROLLBACK	ROLLBACK_CAPTURE_FAILED
PRE_TEST_SNAPSHOT	SNAPSHOT_FAILED
RECONCILE	RECONCILE_FAILED
REVIEW	REVIEW_INCOMPLETE / ZERO_REVIEW / REVIEW_READ_FAILED / SUSPICIOUS_SIGNAL
HUMAN_GATE	REVALIDATION_FAILED
任意 Step	FATAL / ABORTED
未列出的组合 → IllegalTransitionError → NEED_HUMAN。FATAL / ABORTED 用通配或逐 Step 列出，PR 写明。

6.4 executeTask 返回字段映射
返回字段	来源	备注
success	pipelineState.success	Step 值经断言写入；catch 写 false
message	pipelineState.resultMessage	成功由 human_gate 写；失败由 pipeline 显式写。null 返回「pipeline 实现缺陷」
status	恒 'NEED_HUMAN'	现有不变量
round	state.round	StateManager 维护
files	pipelineState.finalFiles ?? Array.from(pipelineState.baseFiles.keys())	对账后以 finalFiles 为准
rollbackPointCaptured	pipelineState.rollbackPointCaptured	capture_rollback 写
P3 不得新增返回字段、不得改语义。

6.5 P3 验收
主干 ≤ 50 行

131 项 selftest 全绿

非法迁移用例

六条回边逐条命中

非回边 NEED_HUMAN 路径逐条命中

锁链单测（同工作区两任务串行）

Step 抛未预期异常 → FATAL + currentState 写入 + 锁释放

success 一致性反例

output 越界键反例

output 禁写键反例

三条失败路径 message 分别断言

diagnostics 不进入 pipelineState

feedback 从 StepResult 顶层读，不进入 pipelineState

convertToWorkflowState 显式映射单测（每个键的持久化 / 不持久化断言）

saveRunning 后 state 文件不含 finalFiles / runner / sandboxPlan / rollbackPointCaptured / sandboxDisabledByConsent / resultMessage / success

7. P4：测试补齐
测试	内容
表驱动	Mock 全部 Step，遍历完整迁移表每条边，断言路由正确
非法迁移	表外组合 → IllegalTransitionError + NEED_HUMAN
回边上限	连续 REJECTED 达 maxRounds - 1 次回边 → NEED_HUMAN；边界 maxRounds=1（0 次回边）与 =3（2 次回边）
终态	从 NEED_HUMAN 起步 → 拒绝
Step 单测	Mock ctx + StateManager，断言 output / diagnostics / feedback / reasonCode / success
崩溃恢复	phase: 'running' 重启 → NEED_HUMAN，不重跑
feedback 单源	① 第 1 轮 REJECTED → 第 2 轮 GENERATE 的 ctx.feedback 含原因；② Step 写 result.feedback → state.feedback 更新且 pipelineState 无该键；③ 崩溃重启后下一轮取 state.feedback
Step 异常边界	Mock Step 抛未预期异常 → FATAL + NEED_HUMAN + currentState 正确 + 锁释放
ReasonCode 语义	四类审查失败各自命中；WRITER_FAILED / REVIEWER_FAILED 走回边；REVALIDATION_FAILED 与 RECONCILE_FAILED 可区分；ABORTED 不进重试
1.x state 不兼容	手工构造 version: 1 的 state → load() 抛错「1.x state 不兼容」；错误文案含「2.0.0」
success 语义	① HUMAN_GATE+OK → true；② 其余终止 → false；③ Step 返回不一致 → 断言拒绝
output 越界键	未知键 → IllegalStepOutputError → FATAL + NEED_HUMAN
output 禁写键	① 任意 Step 写 success → 拒绝；② 非 HUMAN_GATE 写 resultMessage → 拒绝；③ HUMAN_GATE 写 → 通过
diagnostics 通道	① diagnostics.detail 不被拒；② state.stepDiagnostics 与返回值一致；③ 不进入 pipelineState；④ 自定义键不触发错误
feedback 通道	① result.feedback 不被拒；② state.feedback 与返回值一致；③ 不进入 pipelineState
对象只读	① Step 改 ctx.pipelineState.runner 内部状态 → lint 捕获；② Step 持旧引用下一轮反向改 → pipeline 重建 view 不受影响
baseFiles 类型	编译期 .set() 报错；运行时 as any 强写由 lint 断言捕获
corruptionFlags 循环	① update() 后文件无该键；② 连续 load() 幂等返回 flags；③ flags 非空 → 写 NEED_HUMAN → 再 load flags 为空
失败路径 message	三条路径分别断言；resultMessage 为 null 时返回「pipeline 实现缺陷」
返回字段映射	6 字段严格来自映射表；改一个 Step 的 output 不改变返回结构
convertToWorkflowState 显式映射	① baseFiles → writtenFiles（经 buildManifest）；② finalFiles / runner / sandboxPlan / rollbackPointCaptured / sandboxDisabledByConsent / resultMessage / success 不写入 state 文件；③ 不在 StepOutput 中的 WorkflowState 字段不覆盖
saveRunning 持久化边界	saveRunning 后读 state 文件，断言不含运行时字段（finalFiles / runner / sandboxPlan / rollbackPointCaptured / sandboxDisabledByConsent / resultMessage / success）
P2a 导出面	dist/index.js 导出键集合与搬移前快照一致
P2a listRootFoundationFiles 归属	若选 B：listRootFoundationFiles 从 workspace_fs.ts 导出，rollback.ts import 使用；isFoundationName 同位置
8. P5：旁路事件 + 跨进程锁
项	内容
事件	emitTransition(from, event, to) 仅审计/UI/指标；订阅者抛错被捕获，不中断主干
锁位置	O_EXCL 锁文件放 stateDir 下独立子目录（非 backup），不放工作区根
锁失效兜底	tmpdir 被清理 → 锁失效 → 可能并发，但状态文件 SHA256 仍兜底
验收	订阅者抛错主干走完；两进程并发同工作区一方 fail-closed；tmpdir 清理后重跑不误报
9. 已知妥协
项	妥协	记录位置
1.x state 不兼容	2.0.0 的 load() 遇到 version !== 2 直接抛错，不迁移	P1 实现注释 + CHANGELOG
feedback 单源	无 PipelineState.feedback；StepResult.feedback 是唯一出口	P0 契约注释
SNAPSHOT_FAILED 共用码	两条子因通过 diagnostics.detail 区分	Step 实现注释
merge 失败走 FATAL	不回边重写，保持现状	steps/merge.ts 注释
convertToWorkflowState 显式映射	无同名直传；运行时状态不持久化	P3 实现注释
10. 发布与版本判断
2.0.0 是 major，发布判断简化：

1.1.1 作为 patch 独立发布，不阻塞 2.0.0

2.0.0 的 breaking 变更：1.x state 不兼容，需在 CHANGELOG / Release 正文显式声明

其余 breaking 信号：dacw_run / dacw_rollback 参数签名变化、cordis.patch.yml 字段变更、.dacw-workspace 标记格式变化 → 已在 2.0.0 内

发布文案模板：

DACW 2.0.0 是 major 版本，包含 engine 重构（Step 流水线 + 状态机）。
Breaking：不兼容 1.x 的 state 文件格式。升级后旧任务的 state 无法读取，dacw_rollback 对旧任务不可用。请使用 2.0.0 重新运行任务。
1.1.1 作为 patch 独立发布，修复地基文件回滚残留，保 1.1.0 兼容。

11. 明确不做 / 延后
项	原因
完整事件驱动主流程	与 fail-closed、确定性审计冲突
phase: 'running' 自动重跑	非幂等 Step 会半应用叠加
配置任务级快照	ROADMAP §4
对账规则重构	独立模块，可并行
sandbox 决策与执行分离	与状态机正交，P2 不解决
已有项目复用工作区	ROADMAP §4b
1.x → 2.x state 迁移	2.0.0 明确不兼容，拒绝迁移
12. 执行顺序
0.1 合入（1.1.1，单一 PR）：

RollbackPoint.foundationAtStart?: string[]（内部，不在 WorkflowState 顶层）

captureRollbackPoint workspace 模式记录（空工作区显式 []）

rollbackTask 三态清理

selftest.mjs 四场景（含手工构造的 1.1.0 旧 state）

checksum 不动（全字段 SHA256）

P0 开工：写 types.ts + 三条 tsc 验证 → 合入

StepResult 含顶层 feedback?: string

PR 描述引用 §1

P1 开工：state_manager.ts 重定义 → 合入

WorkflowState.version: 2

load() 遇到 version !== 2 抛错

corruptionFlags 不落盘

P2a 开工：抽文件层 → 合入

listRootFoundationFiles / isFoundationName 进 workspace_fs.ts

PR 描述写明归属选择与理由

P2b 开工：抽 Step → 合入

P3 开工：换主干 → 合入

saveRunning(convertToWorkflowState(result.output))

convertToWorkflowState 按显式映射表实现

result.feedback 从顶层读

P4 与 P3 并行收尾

P5 独立开工

发布：1.1.1 patch 先行，2.0.0 随后

后续任何新矛盾，按 §1 执行规则处理——进代码修 + PR 留痕，不回改 v10。

附：三个 PR 描述前置备注（粘贴用）
0.1 PR（1.1.1）：

按 v10：RollbackPoint.foundationAtStart?: string[]（内部）；captureRollbackPoint workspace 模式记录，空工作区显式 []；rollbackTask 三态靠 Array.isArray + 长度区分；checksum 不动（全字段 SHA256，与 1.1.0 算法一致）。无 CHECKSUM_BUSINESS_FIELDS、无 A1 规则、无 fixture 目录、无 SAFETY 披露。selftest 四场景：空工作区 / 有地基文件 / git 模式 / 1.1.0 旧 state（手工构造 JSON，不建 fixture 文件，用 StateManager.computeChecksum 重算 checksum 写回）。

P0 PR（2.0.0 起点）：

按 v10：StepResult 含顶层 feedback?: string；diagnostics / feedback 均为 StepResult 平级字段，不参与 OutputKey 推导。WorkflowState.version: 2 是 2.0.0 标记，load() 遇到 version !== 2 抛错。PR 引用 §1 作为执行规则依据。

P2a PR：

按 v10：listRootFoundationFiles / isFoundationName 搬入 workspace_fs.ts（选项 B），rollback.ts 从 workspace_fs.ts import。理由：文件系统操作与 enumerateWorkspace 同族，禁止留 index.ts（避免循环依赖）。

P3 PR：

按 v10：saveRunning(convertToWorkflowState(result.output))，convertToWorkflowState 按显式映射表实现——baseFiles → writtenFiles（经 buildManifest），其余 7 个键不持久化（运行时状态）。result.feedback 从 StepResult 顶层读，不从 output。均在本 PR 描述留痕。