<div align="center">

# DACW — Defensive Agent Coding Workflow

Let AI write the code, let machines verify it, and let humans make the final call.

[简体中文](README.md) | English | [Safety](SAFETY_EN.md)

</div>

DACW is a **DSH Host plugin**: a writer subagent emits code changes under an incremental protocol, a deterministic runner executes the project's own tests, an independent reviewer returns a structured verdict, and the workflow stops at a human gate. Every failure path converges to `NEED_HUMAN` — **nothing is ever merged automatically**.

## Features

- **Separation of powers**: the writer only emits a JSON changeset, the runner only executes whitelisted commands, the reviewer only emits a verdict — no single party can merge code.
- **Zero-tool child isolation**: writer/reviewer run on persona-only presets; on `agent/created` the plugin uses `ctx.tools.restrict({ allow: [] })` to strip every inherited tool and verifies the child sees zero tools. If isolation fails, the child is never created.
- **Output protocol v2**: the writer emits only deltas against the baseline, untouched files are preserved byte-for-byte, which cuts tokens and prevents "the code that passed last round got broken" regressions.
- **Deterministic runner**: command whitelist (npm / pnpm / yarn / npx / node / python / python3 / pytest / cargo / go), environment whitelist, timeout tree-kill, output truncation.
- **Structured review**: the verdict must be exact JSON; unparseable output is treated as REJECTED; PASS containing suspicious wording goes to the human gate.
- **Configurable models**: writer/reviewer can each inherit the parent session route or select from the DSH configured-model directory; the startup log and the result object show the models actually in effect.
- **Workspace safety gate**: accepts only an empty directory or a valid `.dacw-workspace` marker written by this plugin; refuses filesystem roots, the user home directory, and `DSH_HOME`/profile directories; writes are checked with realpath plus per-segment symlink checks.
- **Audit record**: the state file records the task, file manifest summary, test output and review text, signed with HMAC-SHA256.

## How it works

```
Writer (JSON changeset) → Orchestrator (validate / merge / write) → Runner (project tests)
                                                                    │ failure → rewrite (up to maxRounds)
                                                            Reviewer (JSON verdict) → human gate NEED_HUMAN
```

1. The writer emits deltas under protocol v2.
2. The orchestrator escape-checks paths, merges the baseline, and resets the workspace to the merged set.
3. The runner executes tests by project type (re-sniffed every round).
4. The reviewer audits the full file set plus foundation files (lockfiles as SHA256 digests).
5. On PASS the tool returns `success: true` and `status: "NEED_HUMAN"`; every other path also converges to the human gate.

## Install

Prerequisites: a DSH providing `ctx.subagents`, `agentPresets` and the `spawn` provider (`@deepseek-ai/dsh-subagent-spawn-in-process`); Node ≥ 22.13 for the build; the tested project's dependencies must be installed manually.

```bash
node build.mjs                              # build dist/ (Node built-in type stripping, no typescript)
node selftest.mjs                           # 60 regression vectors
npm pack --pack-destination ../dacw-pack    # produce the install artifact
```

In the DSH plugin manager run `install_bundle` with the tarball's absolute path prefixed by `file:` (for example `file:/absolute/path/to/stmcw1-dacw-1.0.0.tgz`). Installation inserts Host row `dacw` (bundle package `@stmcw1/dacw`) into the profile. **Do not install with a directory path** — a directory install bypasses the `files` whitelist and ships sources, tests and build scripts into the profile.

Upgrade: edit sources → `node build.mjs` → `npm pack` → `remove_bundle` → `install_bundle` the same tarball → restart the Harness.

## Usage

A model calls the `dacw_run` tool:

| Argument | Required | Description |
|---|---|---|
| `task` | yes | Natural-language requirement (the more specific, the better) |
| `workspace` | no | Dedicated workspace; absolute or relative to the session working directory; omitted means the configured value / session working directory |
| `task_id` | no | Suffix for the audit record filename; auto-generated when omitted |

On success:

| Field | Description |
|---|---|
| `success` / `status` | Machine-gate result; `status` is always `NEED_HUMAN` |
| `message` | Human-readable conclusion |
| `workspace` / `files` / `round` | Workspace, produced files, terminating round |
| `models` | `{ writer, reviewer }`, the models actually in effect |
| `logs` / `elapsed_ms` | Log tail and elapsed time |

Example startup log line:

```
🧠 模型配置 | ✍️ 写手: deepseek-account/deepseek-flash（插件配置） | 🔍 审查者: 继承父会话路由（DSH 默认: deepseek-account/deepseek-flash）
```

On workflow failure the tool throws (including workspace, status, round and log tail) instead of returning a normal failure result; no path commits or merges anything.

## Model configuration

`writerModel` / `reviewerModel` accept four forms:

| Value | Behavior |
|---|---|
| `null` / `"inherit"` | Inherit the parent session route (default) |
| `"provider/model"` | Explicit; the provider must be registered in DSH |
| `"model"` | Resolve the unique provider from the DSH configured-model directory |
| `{ provider?, model, reasoningEffort? }` | Object form; `reasoningEffort` is forwarded to the child |

```yaml
config:
  writerModel: deepseek-account/deepseek-flash
  reviewerModel: { model: deepseek-flash, reasoningEffort: high }
```

Resolution happens at the start of every tool call, so DSH settings changes apply immediately; a resolution failure fails closed and never silently switches models.

## Safety

DACW executes model-generated code and commands and is **not a container-grade sandbox**. Run it in a disposable or dedicated environment under a least-privilege account, and always keep the human gate. See [SAFETY_EN.md](SAFETY_EN.md) for the full boundaries and disclaimer.

## Project layout

| Path | Responsibility |
|---|---|
| `plugin.ts` | DSH Host half: tool registration, child presets, runtime tool isolation, model resolution, workspace gate |
| `index.ts` | Orchestrator: rounds, baseline merge, runner dispatch, verdict, human gate |
| `runner.ts` | Runner: command resolution, timeout tree-kill, output truncation |
| `state_manager.ts` | State: atomic writes, HMAC, serial queue |
| `build.mjs` / `selftest.mjs` | Build (TS → `dist/`) and regression self-test |
| `cordis.patch.yml` / `locale/` / `icon.png` | Plugin manifest and display resources |

## Development

- `dist/` is produced by `build.mjs` with Node built-in type stripping; it needs no `typescript` and is not committed.
- Run `node build.mjs && node selftest.mjs` before submitting changes.
- Every config field and its default lives in `DEFAULT_PLUGIN_CONFIG` in `plugin.ts` (each can be overridden in the `config` block of `cordis.patch.yml`).
- Experimental project; interfaces and behavior may change.

## Status

Experimental developer preview (current version `v1.0.1`, bundle `@stmcw1/dacw`): the build smoke check and regression self-test pass, and a live loop has been verified on the DSH `desktop` profile (writer produced files → `npm test` passed → independent reviewer PASS → `NEED_HUMAN`), with child tool isolation measured in effect. Issues and PRs are welcome.

## License

Released under the [MIT](LICENSE) license.

<p align="right">npm: <code>@stmcw1/dacw</code> · <a href="https://github.com/stmcw1/DACW">GitHub</a></p>
