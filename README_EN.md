<div align="center">

# DACW — Defensive Agent Coding Workflow

Let AI write the code, let machines verify it, and let humans make the final call.

[简体中文](README.md) | English | [Safety](SAFETY_EN.md)

</div>

DACW is a **DSH Host plugin**: a writer subagent emits code changes under an incremental protocol, a deterministic runner executes the project's own tests, an independent reviewer returns a structured verdict, and the workflow stops at a human gate. Every failure path converges to `NEED_HUMAN` — **nothing is ever merged automatically**.

## Features

- **Separation of powers**: the writer only emits a JSON changeset, the runner only executes whitelisted commands, the reviewer only emits a verdict — no single party can merge code.
- **Zero-tool child isolation**: writer/reviewer run on persona-only presets; on `agent/created` the plugin uses `ctx.tools.restrict({ allow: [] })` to strip every inherited tool and verifies the child sees zero tools. If isolation fails, the child is never created.
- **Independent workspace (version-control isolation only; test execution still runs with host-user privileges)**: DACW reads, writes and resets files only inside the dedicated workspace directory, never touching the main branch or other directories; this is version-control-level isolation, and test commands still execute with host-user privileges.
- **Execution isolation off by default (host)**: `sandbox.mode` defaults to `"host"` — tests run writer-produced code with host-user privileges (no container isolation). Set `"auto"` explicitly to containerize when Docker is available and to get an interactive confirmation when it is not (keeping the sandbox or being unable to ask fails closed).
- **Output protocol v2**: the writer emits only deltas against the baseline, untouched files are preserved byte-for-byte, which cuts tokens and prevents "the code that passed last round got broken" regressions.
- **Deterministic runner**: command whitelist (npm / pnpm / yarn / npx / node / python / python3 / pytest / cargo / go), environment whitelist, timeout tree-kill, output truncation.
- **Structured review**: the verdict must be exact JSON; unparseable output is treated as REJECTED; PASS containing suspicious wording goes to the human gate.
- **Configurable models**: writer/reviewer can each inherit the parent session route or select from the DSH configured-model directory; the startup log and the result object show the models actually in effect.
- **Workspace safety gate**: accepts only an empty directory or a valid `.dacw-workspace` marker written by this plugin; refuses filesystem roots, the user home directory, and `DSH_HOME`/profile directories; writes are checked with realpath plus per-segment symlink checks.
- **Audit record**: the state file records the task, file manifest summary, test output and review text, signed with HMAC-SHA256.

> **Trust boundary**: tests execute before any review, so review is a detective control, not a preventive one; child tool isolation is not a code-execution security boundary. See [SAFETY_EN.md](SAFETY_EN.md).

## How it works

```
Writer (JSON changeset) → Orchestrator (validate / merge / write) → Runner (project tests)
                                                                    │ failure → rewrite (up to maxRounds)
                                                              Reviewer (JSON verdict) → human gate NEED_HUMAN
```

1. The writer emits deltas under protocol v2.
2. The orchestrator escape-checks paths, merges the baseline, and resets the workspace to the merged set.
3. The runner executes tests by project type (re-sniffed every round) — **this is the first execution of writer-produced code, and it happens before review**.
4. The reviewer audits the full file set plus foundation files (lockfiles as SHA256 digests).
5. On PASS the tool returns `success: true` and `status: "NEED_HUMAN"`; every other path also converges to the human gate.

## Install

> **Prerequisite (DSH host environment)**: the host must provide the `agentPresets` and `subagents` services (`ctx.subagents` / `agentPresets`; a recent DSH release is recommended). On an older host DACW fails closed and refuses to run, preserving the isolation safety floor: subagents must run on zero-tool presets and isolation must be verifiable; in addition, when sandbox mode (`docker` / `auto`) cannot provide a container, tests are refused as well (fail-closed) — there is no silent fallback to host execution.

Prerequisites: a DSH providing `ctx.subagents`, `agentPresets` and the `spawn` provider (`@deepseek-ai/dsh-subagent-spawn-in-process`); Node ≥ 22.13 for the build; tests run on the host by default (no isolation, requires a working npm / pytest toolchain) — for container isolation install Docker and set `sandbox.mode: "docker"`/`"auto"` (sandbox branch); the tested project's dependencies must be installed manually.

```bash
node build.mjs                              # build dist/ (Node built-in type stripping, no typescript)
node selftest.mjs                           # 100 regression vectors
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

## Sandbox configuration

`config.sandbox` decides where tests execute (**`host` by default — execution isolation off, tests run with host-user privileges**).

- For stronger isolation, explicitly set `sandbox.mode: "auto"`: Docker available → one-shot container (no network, read-only root filesystem, non-root, cap-drop ALL, resource-limited); Docker unavailable → interactive confirmation asking whether to downgrade — "keep sandbox" or no answer fails closed (never a silent downgrade).
- Explicit `sandbox.mode: "docker"`: force a container; when Docker is unavailable the run is refused (no prompt, no downgrade).
- Explicit `mode: "host"` produces a red startup warning (the default value does not warn).

> Confirmation text (only for `auto` when Docker is unavailable): No usable sandboxed isolation environment was detected (e.g. Docker is not installed or not running). Disable sandbox mode and continue?

| Mode | Behavior |
|---|---|
| `host` (default) | Run on the host (no isolation): execution isolation is off, tests run with host-user privileges |
| `auto` | Docker available → one-shot container; unavailable → human confirmation; keep/unavailable → fail-closed |
| `docker` | Force a one-shot container; Docker unavailable → run refused (no prompt, no downgrade) |

```yaml
config:
  sandbox:
    mode: host                # host (default) | auto | docker
    image: ''                 # empty = pick an official image per test command; or pin e.g. node:22-bookworm-slim
    memoryMb: 1024
    cpus: 1                   # fractions allowed
    pidsLimit: 256
    tmpfsMb: 128
```

Container constraints in docker mode (sandbox branch): `--network none` (no network), read-only root filesystem (only a /tmp tmpfs is writable), non-root (uid/gid 1000), `--cap-drop ALL`, `no-new-privileges`, memory / CPU / PID limits, `--rm` one-shot; the workspace is copied into a disposable staging directory and that copy is mounted — the host workspace itself never enters the container. Pre-pull the image on first use (node default `node:22-bookworm-slim`, python `python:3.12-slim`, cargo `rust:1-slim`, go `golang:1.23-bookworm`).

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

Execution isolation is off by default: tests run with host-user privileges; setting `sandbox.mode: "auto"` explicitly containerizes when Docker is available and asks the human when it is not (keeping the sandbox or being unable to ask fails closed).

DACW executes model-generated code and commands. **Tests execute before any review**, so review (including the human gate) is a detective control, not a pre-execution security barrier; child tool isolation is not a code-execution security boundary.

- Default `sandbox.mode: "host"`: execution isolation is off, tests run with host-user privileges; setting `"auto"` containerizes when Docker is available and asks the human when it is not (keeping it or being unable to ask fails closed, never a silent downgrade).
- When the user explicitly confirms a downgrade (`auto` with the sandbox disabled) or sets `sandbox.mode: "host"`, arbitrary writer-produced code (including `package.json` test/pretest scripts) runs with the full privileges of the host user, flagged as a **[security downgrade]** / red warning; docker mode is not perfect isolation either (shared host kernel, image must be trusted).
- Review completeness is fail-closed by default: truncated review input or a lockfile sent only as a digest makes `success` false and routes to the human gate; `allowTruncatedReview: true` explicitly lets it pass (**lowers the security guarantee**; message/files/logs are flagged).
- Sensitive files (`.env`, `*.pem`, `*.key`, `credentials*`, `secrets*`, `id_rsa*` etc.) are not sent to model review by default (their content is not sent to the model), but they are still delivered and kept in the `files` manifest; the message lists them and they must be reviewed manually.
- Run in a disposable or dedicated environment under a least-privilege account, and always keep the human gate.

See [SAFETY_EN.md](SAFETY_EN.md) for the full boundaries, execution order and disclaimer.

## Project layout

| Path | Responsibility |
|---|---|
| `plugin.ts` | DSH Host half: tool registration, child presets, runtime tool isolation, model resolution, workspace gate |
| `index.ts` | Orchestrator: rounds, baseline merge, runner dispatch, verdict, human gate |
| `sandbox.ts` | Sandbox policy: host (default)/auto/docker decision, container args, Docker detection, auto-downgrade consent request |
| `runner.ts` | Runner: command resolution, timeout tree-kill, output truncation |
| `state_manager.ts` | State: atomic writes, HMAC, serial queue |
| `build.mjs` / `selftest.mjs` | Build (TS → `dist/`) and regression self-test |
| `cordis.patch.yml` / `locale/` / `icon.png` | Plugin manifest and display resources |

## Development

- `dist/` is produced by `build.mjs` with Node built-in type stripping; it needs no `typescript` and is not committed.
- Run `node build.mjs && node selftest.mjs` before submitting changes.
- Every config field and its default lives in `DEFAULT_PLUGIN_CONFIG` in `plugin.ts` (each can be overridden in the `config` block of `cordis.patch.yml`); sandbox defaults live in `DEFAULT_SANDBOX_CONFIG` in `sandbox.ts`.
- Experimental project; interfaces and behavior may change.

## Status

Experimental developer preview (current version `v1.1.0`, bundle `@stmcw1/dacw`): the build smoke check and regression self-test pass. The default execution policy is host (no isolation); one-shot container execution (`docker`/`auto`) is developed on the sandbox branch. The v1.0.2 live host-execution loop verified on the DSH `desktop` profile (writer produced files → `npm test` passed → independent reviewer PASS → `NEED_HUMAN`, child tool isolation measured in effect) still holds under the default configuration. Issues and PRs are welcome.

## License

Released under the [MIT](LICENSE) license.

<p align="right">npm: <code>@stmcw1/dacw</code> · <a href="https://github.com/stmcw1/DACW">GitHub</a></p>
