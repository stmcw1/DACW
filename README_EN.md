<div align="center">
  <a href="https://stmcw1.github.io/DACW/dacw-workflow.html" target="_blank">
    <img src="https://stmcw1.github.io/DACW/dacw.webp" alt="DACW workflow diagram" width="100%">
  </a>
</div>

<div align="center">

# DACW — Defensive Agent Coding Workflow

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![npm version](https://img.shields.io/npm/v/@stmcw1/dacw.svg)](https://www.npmjs.com/package/@stmcw1/dacw)
[![Node.js Version](https://img.shields.io/node/v/@stmcw1/dacw.svg)](https://nodejs.org)

Let AI write the code, let machines verify it, and let humans make the final call.

[简体中文](README.md) | English | [Safety](SAFETY_EN.md)

</div>

DACW is a **DSH Host plugin**: a writer subagent emits code under an incremental protocol → a deterministic runner executes the project's own tests → an independent reviewer returns a JSON verdict → the workflow stops at the human gate. Every failure and anomaly path converges to `NEED_HUMAN` — **nothing is ever merged automatically**.

## How it works

```
Writer → Orchestrator (validate / merge / write) → Runner (project tests) → Reviewer (JSON verdict) → Human gate
```

- Every round resets the workspace to the "baseline merged set"; untouched files are preserved byte-for-byte.
- **Tests execute before review**: review is a detective (post-hoc) control, not a pre-execution barrier; the human gate is the final backstop.
- After tests pass, the workspace is re-enumerated and reconciled against the baseline; any unexplained addition/deletion/content change → straight to the human gate, never into review.

## Features

- **Separation of powers**: the writer emits only a changeset, the runner executes only whitelisted commands, the reviewer only emits a verdict — no party can merge code on its own; if isolation fails, the run is refused (fail-closed).
- **Zero-tool child subagents**: writer/reviewer run on persona-only presets; on creation every inherited host tool is stripped and the child is verified to see zero tools.
- **Independent workspace**: reads, writes and resets only inside the directory you designate (version-control-level isolation; tests still run with host privileges); the gate refuses filesystem roots, the user home directory and DSH profile directories.
- **Deterministic runner**: command/environment whitelists, timeout tree-kill, output truncation, secret redaction.
- **Output protocol v2**: the writer emits only deltas and untouched files are preserved; post-test reconciliation guarantees "what was reviewed === what is delivered".
- **Secret controls, three layers**: sensitive files are not sent to model review, writer-output credentials are scanned (a hit rejects that round), runner output is redacted (`[REDACTED:<category>]`).
- **Configurable models**: writer/reviewer configured independently — inherit the parent session, explicit `provider/model`, or local models.
- **Rollback (human-triggered)**: a rollback point is captured before the task starts; `dacw_rollback` requires `confirm: true` plus human confirmation (headless hosts need `DACW_ROLLBACK_TOKEN`).

> **Trust boundary**: DACW executes model-generated code. Tests run before review, so review is a detective control; child tool isolation is not a code-execution security boundary. See [SAFETY_EN.md](SAFETY_EN.md).

## Install

**Prerequisite**: DSH ≥ 0.2.2-rc.1 (current tested version); the host must provide the `ctx.subagents`, `agentPresets` and `tools` services. DACW depends on DSH's official `dsh-persona` and `dsh-subagent-spawn-in-process`; no third-party plugins are required.

Activation probes the required host capabilities and refuses to activate with a "host incompatible" error when any is missing; sandbox and child isolation must be verifiable — any unconfirmable path fails closed. Building requires Node ≥ 24.9; the tested project's dependencies must be installed manually.

```bash
node build.mjs                              # build dist/ (Node built-in type stripping, no typescript)
node selftest.mjs                           # 135 regression vectors
npm pack --pack-destination ../dacw-pack    # produce the install artifact
```

In the DSH plugin manager run `install_bundle` with the tarball's absolute path prefixed by `file:` (e.g. `file:/absolute/path/to/stmcw1-dacw-1.1.1.tgz`). Installation inserts Host row `dacw` (bundle package `@stmcw1/dacw`) into the profile. **Do not install with a directory path** — it bypasses the `files` whitelist and ships sources, tests and build scripts into the profile.

Upgrade: edit sources → `node build.mjs` → `npm pack` → `remove_bundle` → `install_bundle` the same tarball → restart the Harness.

## Usage

A model calls `dacw_run`:

| Argument | Required | Description |
|---|---|---|
| `task` | yes | Natural-language requirement (the more specific, the better) |
| `workspace` | no | Dedicated workspace; absolute or relative to the session working directory; omitted means the configured value / session working directory |
| `task_id` | no | Suffix for the audit record filename; auto-generated when omitted |

Returns `success` / `status` (always `NEED_HUMAN`) / `message` / `workspace` / `files` / `round` / `models` / `logs` / `elapsed_ms` / `task_id` / `rollback_available`. On failure the tool throws with the workspace, status, round and log tail instead of disguising failure as a normal result; no path commits or merges anything.

### Using with an existing project

Do not use the project root as the workspace. Recommended setup — create an empty subdirectory under the project:

```
your-project/
├── .dacw-work/        ← workspace, add to .gitignore
├── src/
└── package.json
```

Each round only resets non-foundation files inside `.dacw-work/`; the rest of the project is untouched. The subdirectory does not inherit the outer project's dependencies — point the test command at the outer toolchain or install dependencies inside the subdirectory beforehand; same for pure Python/Go projects.

> Do not hand-craft a `.dacw-workspace` marker to bypass the empty-directory check: the marker is written by the plugin to mean "this directory may be reset"; hand-crafting it voluntarily hands the directory to the reset logic.

### Rollback

`dacw_rollback` is a high-impact operation: it **must be called with `confirm: true`** (a literal boolean), then requests interactive human confirmation; when the host has no interaction capability, set `DACW_ROLLBACK_TOKEN` or the call is refused. git workspaces get rollback instructions (DACW executes no git command); non-git workspaces are restored from the backup. The task terminates after rollback.

## Configuration

### Where tests execute (sandbox)

**Default `host`: execution isolation is off; tests run writer-produced code with host-user privileges.**

| Mode | Behavior |
|---|---|
| `host` (default) | Run on the host (no isolation); a red warning is printed at startup when explicitly configured |
| `auto` | Docker available → one-shot container; unavailable → interactive confirmation whether to downgrade; keep/unavailable → fail-closed |
| `docker` | Force a one-shot container; Docker unavailable → run refused (no prompt, no downgrade) |

Container constraints in `docker` mode: no network, read-only root filesystem, non-root, `--cap-drop ALL`, `no-new-privileges`, memory/CPU/PID limits, `--rm` one-shot; the workspace is copied into a disposable staging directory and mounted. **Docker mode is not perfect isolation either** (shared host kernel, image must be trusted).

```yaml
config:
  sandbox:
    mode: host                # host (default) | auto | docker
    image: ''                 # empty = pick an image per test command
    memoryMb: 1024
    cpus: 1
    pidsLimit: 256
    tmpfsMb: 128
```

### Writer / reviewer models

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

A resolution failure fails closed and never silently switches models. Local models can be connected through DSH's Custom model API (`@deepseek-ai/dsh-llm-pi-ai` — Ollama / LM Studio / vLLM) by configuring `provider/model`; local small models fail closed to the human gate more often — expected behavior.

## Safety

- **Default `host` has no isolation**: tests run arbitrary writer-produced code (including `package.json` test/pretest scripts) with host-user privileges, flagged as a **[security downgrade]** / red warning; use only in a disposable or dedicated environment under a least-privilege account.
- **Review completeness is fail-closed by default**: truncated review input or a lockfile sent only as a SHA256 digest makes `success` false; `allowTruncatedReview: true` explicitly lets it pass (**lowers the security guarantee**; message/files/logs are flagged).
- **Sensitive files are not sent to model review**: identified by filename (`.env`, `*.pem`, `*.key`, `credentials*`, `secrets*`, `id_rsa*`, etc.); their content is not sent to the model, but they are still delivered and kept in the `files` manifest and must be reviewed manually.
- **Audit boundary**: state files and logs use deterministic SHA-256 against accidental corruption, not against recomputation by a same-account local user; export and store evidence externally when strong evidence is required.
- **The human gate is the final backstop**: PASS containing suspicious wording, incomplete review, post-test reconciliation mismatch, etc. all route to the human gate.

See [SAFETY_EN.md](SAFETY_EN.md) for the full boundaries, execution order and disclaimer; known limitations: [ROADMAP.md](ROADMAP.md) section "4b".

## Development

```bash
node build.mjs        # dist/ is generated with Node built-in type stripping; no typescript, not committed
node selftest.mjs     # run build + selftest before submitting changes
```

Project layout: `plugin.ts` (Host half), `index.ts` (orchestrator), `runner.ts` (runner), `sandbox.ts` (sandbox policy), `secrets.ts` (secret detection/redaction), `state_manager.ts` (state). Diagram: [docs/dacw-workflow.html](docs/dacw-workflow.html). Config defaults live in `DEFAULT_PLUGIN_CONFIG` (`plugin.ts`) and `DEFAULT_SANDBOX_CONFIG` (`sandbox.ts`); `cordis.patch.yml` can override each field. Experimental project; interfaces and behavior may change.

## Status

Experimental developer preview (current release `v1.1.1`, bundle `@stmcw1/dacw`): the build smoke check and 135 regression vectors pass; `v1.1.1` fixes leftover root-level foundation files after rollback (compatible with 1.1.0 state). Execution isolation is off by default (`host`). Known limitations: [ROADMAP.md](ROADMAP.md) section "4b". `2.0.0` (engine refactor) is planned.

## License

Released under the [MIT](LICENSE) license.

<p align="right">npm: <code>@stmcw1/dacw</code> · <a href="https://github.com/stmcw1/DACW">GitHub</a></p>
