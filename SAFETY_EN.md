# Safety

[简体中文](SAFETY.md) | English

## Experimental status

DACW is an experimental developer-preview plugin. It has not undergone a security audit and must not be used in production. It executes model-generated code and commands (npm / pytest / cargo / go etc.); wrong model output, defects, misconfiguration or malicious input may damage the host, leak data, or cause other unintended effects.

## Execution order and the limits of review (important)

DACW runs: writer writes files → runner executes tests → reviewer audits → human gate.

- **Tests execute before any review.** By the time the reviewer (model or human) sees the code, it has already run once. Review is a *detective* control (it detects problems that already happened), **not a preventive control** (it does not stop execution).
- **Child tool isolation is not a code-execution security boundary.** It only constrains whether the writer/reviewer subagents can call host tools; it does not constrain the test subprocesses spawned by the runner.
- The writer can modify the `scripts` field of `package.json` directly (`test` / `pretest` / `posttest` etc.), and the test command executes arbitrary commands from it; the test code itself is also produced by the writer. Therefore **"the reviewer looked at it first" must not be treated as a security guarantee for code execution**.

## Post-test reconciliation (review target === final deliverable)

The test command runs writer-produced code, and that code can rewrite the workspace during the test: create files, delete files, tamper with already-generated content (for example `fs.writeFileSync('unreviewed.js', ...)` in a test script, or appending code to a deliverable file). If review only looks at "the baseline manifest the writer declared", those test-time changes bypass review and enter the final deliverable.

DACW therefore reconciles between a passing test and the review stage:

- Before the test it takes a SHA256 snapshot of the workspace: the expected state = writer baseline ∪ foundation files that already existed before the test (package.json etc.); the baseline portion must match what was written byte-for-byte, otherwise the run goes straight to the human gate;
- After the test passes it re-enumerates the workspace recursively, hashes every file and compares against the snapshot;
- Any addition (+), deletion (-) or content change (~) → immediate human gate (`success: false`), the review stage is not entered;
- Once reconciliation passes, both the review input and the result `files` manifest come only from the reconciled final list, and review reads the current on-disk content.

The ignore rules apply **only at the workspace root** (F1). The root `.dacw-workspace` is DACW's own marker file and carries no content risk. The root `.git` / `node_modules` are not simply ignored as "harmless": DACW records a fingerprint of "existence + top-level entry list + SHA256 digest" (F2) — adding/removing a top-level entry, or creating/deleting the whole directory during the test, goes to the human gate. Same-named entries in subdirectories (e.g. `nested/node_modules/payload.js`) are **not** ignored and are reconciled and reviewed like any other file; otherwise a test could drop files into nested directories and bypass reconciliation entirely. Everything else must be explainable as "declared in the baseline or already present before the test" — one extra file is a difference. Enumeration failures fail closed the same way: a symlink or non-regular file aborts the reconciliation into the human gate.

Before returning success, a final consistency assertion (F3) is enforced: `postDigest`, `finalFiles` and the key set actually iterated by the review loop must all agree, and a fresh enumeration (files plus protected-directory fingerprints) must exactly match the reconciled state; any mismatch (including truncated review input or workspace changes during review) → `success: false` to the human gate, never `success: true`.

**Review completeness is likewise fail-closed (G).** When review input is truncated by a character cap (single file or total input), `reviewTruncated` is set; when a lockfile is sent only as a SHA256 digest it counts as not semantically reviewed (`reviewPartial`, with integrity guaranteed by the pre/post-test digest reconciliation). Under the default configuration neither path may pass: `success` is always false and the run goes to the human gate, with a report listing unreviewed files, per-file truncation positions and the total input cap. The only escape hatch is explicitly setting `allowTruncatedReview: true`: truncated/digest-only reviews may then pass, but the message is flagged as a security downgrade, `files` marks the unreviewed items and the log warns — **an explicit choice that lowers the security guarantee**, off by default.

Differences go straight to the human gate instead of back to the writer for three reasons: test-time changes are not the writer's output, so the writer cannot see or explain them; they usually signal test-side injection/tampering or a broken test design and need human adjudication of the actual state; and sending them back would let the next round overwrite the evidence.

## Sandbox (where tests execute)

Execution isolation is off by default: tests run writer-produced code with host-user privileges. Setting `sandbox.mode: "auto"` explicitly containerizes when Docker is available; when it is not, a human confirmation ("disable sandbox?") is shown — keeping the sandbox or being unable to ask fails closed (never a silent downgrade).

`config.sandbox` decides where tests run:

| Mode | Behavior | Isolation |
|---|---|---|
| `host` (default) | Run on the host: writer-produced code runs with the full privileges of the host user (execution isolation off by default; red startup warning) | **None** |
| `auto` (optional) | Docker available → one-shot container; unavailable → human confirmation; keep/unavailable → **tests are refused** (fail-closed) | Container-grade (see below) |
| `docker` (optional) | Force a one-shot container; Docker unavailable → **run refused** (no prompt, no downgrade) | Container-grade (see below) |

Container constraints in docker mode: `--network none` (no network), read-only root filesystem (only a /tmp tmpfs is writable), non-root user (uid/gid 1000), `--cap-drop ALL`, `no-new-privileges`, memory / CPU / PID limits, `--rm` one-shot; the workspace is first copied into a disposable staging directory and that copy is mounted — **the host workspace itself never enters the container**.

**docker mode is not perfect isolation either**: containers share the host kernel, the image must be trusted (use only official or reviewed images), and the Docker Desktop file-sharing layer has its own attack surface; pre-pull the image before first use or the pull time may trip the test timeout.

With the default host mode (or when the user confirms disabling the sandbox under `auto`), arbitrary writer-produced code (including `package.json` test/pretest scripts) runs with the full privileges of the host user; the result message is flagged as a security downgrade / states where tests executed, and the log carries a red warning. In host mode the command whitelist, environment whitelist, HMAC signing, review and human gate reduce risk but **do not constitute isolation**; do not treat DACW as the sole security control for untrusted workloads.

## Key boundaries

- The plugin runs inside the DSH Host process and reads/writes the workspace and state files through `node:fs`, outside the DSH session file sandbox; effective file permissions are those of the system account running the Harness.
- Writer/reviewer are real subagent sessions (visible in the profile); with an explicitly configured model, the task description and workspace code are sent to the selected model provider.
- The workspace is reset to the non-foundation file set every round — destructive by design; `workspacePolicy: "allow"` skips the empty-directory/marker check.
- State files default to `os.tmpdir()/dacw-state` and contain the task description, test output and review text; they are never cleaned automatically and have no crash recovery.
- Child tool isolation relies on the host's `ctx.tools.restrict` and the `agent/created` event; when isolation or preset registration fails the run is refused by default. **Being unable to confirm isolation is itself a failure**: if the provider returns no valid childId, or the child context lacks validation capability such as `tools.schemas`, the call is aborted and never recorded as successful. The only escape hatch is explicitly setting `enforceChildToolIsolation=false` (accepting that children may inherit host tools); `allowInheritedPresets` is only meaningful as a companion option after the isolation requirement is turned off.
- The tested project's dependencies must be installed manually; `node_modules` is treated as a trusted base — test processes can read and write them, especially in host mode.
- The reviewer model can be hijacked by instructions planted in the workspace, and a well-formed forged PASS can still appear — **the human gate is the final line of defense**.

## Responsible use

- Install only bundles you have reviewed and trust; installing/upgrading modifies the whole DSH profile.
- Under the default configuration tests run with host-user privileges: use a dedicated or disposable environment under a least-privilege account, and make sure you trust the writer output and workspace contents.
- For container isolation, install Docker and set `sandbox.mode: "docker"`/`"auto"` (sandbox branch); docker mode is not perfect isolation either.
- Use a dedicated empty workspace and back up files it can access.
- Do not expose sensitive credentials or data to untrusted models.
- Do not merge output before the NEED_HUMAN human review is complete.

## Disclaimer

Use DACW only with a full understanding of these risks. To the maximum extent permitted by applicable law, the authors and copyright holders are not liable for any computer damage, data loss or leakage, file loss, or other damages arising from the use of this project.
