# Safety

[简体中文](SAFETY.md) | English

## Experimental status

DACW is an experimental developer-preview plugin. It has not undergone a security audit and must not be used in production. It executes model-generated code and commands (npm / pytest / cargo / go etc.) and grants them access to workspace files, environment variables and local processes; wrong model output, defects, misconfiguration or malicious input may damage the host, leak data, or cause other unintended effects.

## Sandbox limitations

DACW is **not a container-grade sandbox**: child processes run with the same user and privileges as the host and can access the network. Command whitelists, environment isolation, HMAC signing, structured verdicts and the human gate reduce risk but do not constitute isolation. Do not treat DACW as the sole security control for untrusted workloads.

## Key boundaries

- The plugin runs inside the DSH Host process and reads/writes the workspace and state files through `node:fs`, outside the DSH session file sandbox; effective file permissions are those of the system account running the Harness.
- Writer/reviewer are real subagent sessions (visible in the profile); with an explicitly configured model, the task description and workspace code are sent to the selected model provider.
- The workspace is reset to the non-foundation file set every round — destructive by design; `workspacePolicy: "allow"` skips the empty-directory/marker check.
- State files default to `os.tmpdir()/dacw-state` and contain the task description, test output and review text; they are never cleaned automatically and have no crash recovery.
- Child tool isolation relies on the host's `ctx.tools.restrict` and the `agent/created` event; when isolation or preset registration fails the run is refused by default (it can be disabled explicitly with `enforceChildToolIsolation` / `allowInheritedPresets`, which gives up the corresponding guarantee).
- The tested project's dependencies must be installed manually; `node_modules` is treated as a trusted base.
- The reviewer model can be hijacked by instructions planted in the workspace, and a well-formed forged PASS can still appear — **the human gate is the final line of defense**.

## Responsible use

- Install only bundles you have reviewed and trust; installing/upgrading modifies the whole DSH profile.
- Run in a disposable or dedicated environment under a least-privilege account; use a dedicated empty workspace and back up files it can access.
- Do not expose sensitive credentials or data to untrusted models.
- Do not merge output before the NEED_HUMAN human review is complete.

## Disclaimer

Use DACW only with a full understanding of these risks. To the maximum extent permitted by applicable law, the authors and copyright holders are not liable for any computer damage, data loss or leakage, file loss, or other damages arising from the use of this project.
