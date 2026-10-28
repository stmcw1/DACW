# VET health record: @stmcw1/dacw@1.0.0（改名升版审计，承接 @local/dacw@0.1.0 批准记录）

- Scanned at: 2026-10-29T02:40:00+08:00
- Static verdict: 🟠 suspicious (static score 61/100)

## Static findings
- [R3] high ×1: 直接访问 process.kill（runner.js:262）——POSIX 进程组强杀
- [R11] medium ×3: fs.rm/fs.unlink（index.js:277/281 工作区清理、state_manager.js:71 state tmp 失败清理）
- [R3] info ×27 / [R9] info ×4 / [R6] info ×1

## Agent investigation
- Risk: low
- Recommendation: **approve（附逐条排除理由）**
- Summary: 包由 @local/dacw@0.1.0 改名为 @stmcw1/dacw 并升版 1.0.0。runner.js 与 state_manager.js 字节级未变（12382/5223，与已批准版本一致）；index.js 微增（31364→31957，+~600B）；plugin.js 显著增长（35007→46514，+33%，对应新增 agentPreset 诊断、配置面扩展与文档化改进）。静态发现集合与已批准的 0.1.0 复扫完全同构，critical 为零。真实可用性测试（8+ 次调用）中 fail-closed 默认值经受住实战考验：agentPresets 服务缺失时连续 5 次拒绝运行（未静默放行），逃生门 allowInheritedPresets 使用后正确回归 false。smoke-test3 状态记录（dacw-mvsg41oq）独立佐证正规路径闭环：3 文件 sha8 清单 → 真实 npm test 输出 → 围栏包裹 PASS 裁决 → NEED_HUMAN。

## Quality audit (step 4.5)
- Contract: ✅ exports/inject/apply 形状/cordis.patch.yml（830B，配置键扩展）/engines node>=22.13 全部一致
- Lifecycle: ✅ 同已批准版本（disposer/abort 清理模式未变）
- Defect list:
  - D-1（P3，归档勘误）：测试归档称"冒烟工作区在 DACW 重激活时自动清理"——**代码不支持该归因**：dist/plugin.js 全文无任何工作区目录删除逻辑（marker 仅写入/校验；index 侧 safeCleanWorkspace 只重置内容不删目录）。实际清道夫未查明（人工/外部清理）。该归因已在审计回复中要求更正
  - D-2（P3）：plugin.js +33% 增量未做逐行 diff（源码不随包分发，属设计）；静态画像与运行验证覆盖风险
  - D-3（P3）：SAFETY.md 由 7.3KB 压缩至 2.5KB——经全文核对为**加密而非删失**，且新增两条高价值披露（插件经 node:fs 直写绕过会话文件沙箱；工作区代码会发送给所选模型提供方）
- Impact: 无拖累宿主、无静默失败路径

## Review trail (evidence)
- 静态画像与 20261029-002700 批准记录完全同构（critical 0 / high 1 / medium 3），逐条排除理由沿用：process.kill=超时强杀必需路径；fs.rm/unlink=白名单保护下的核心清理职能
- 运行证据：state_dacw-mvsg41oq_bd23ba5f.json（2:26:35）——taskId、round 1、NEED_HUMAN、HMAC 完好
- 可用性测试归档 dacw-test-archive.md 核验：9 次调用时间线、根因分析（preset 激活期采样与代码一致）、逃生门使用与回归、任务描述经验（须允许创建 package.json）均属实；唯"重激活自动清理"归因不成立（D-1）
- 旧 @local/dacw 已从 node_modules 移除（无双包残留），旧批准记录由本记录承接
