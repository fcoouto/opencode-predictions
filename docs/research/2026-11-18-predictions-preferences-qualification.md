# Prediction preferences qualification

Implementation: `feat/prediction-preferences`, based on `ca8d1c0`. The separate manual-prediction-hint PR is not included.

Contract: [approved design](../superpowers/specs/2026-11-18-predictions-preferences-design.md). Preferences belong to the selected server, not the client or project. OpenCode configuration remains an inherited fallback and is never rewritten by Save.

## Tested hosts

- macOS, OpenCode CLI/server **2.2.6**, pinned plugin/client packages **2.2.6**, Node **26.13.0**.
- macOS, OpenCode Desktop and its bundled server **2.3.0**.
- Ordinary shared-service CLI, without `--standalone`, `--server`, or `OPENCODE_DISABLE_PROJECT_CONFIG`.
- Additional standalone CLI regression, also with project discovery enabled.
- Isolated fixture HOME/XDG directories only. No user installation, configuration, service, or credentials were changed.

The shared-service proof checks the actual `serve --service` process and discovers its registration after the CLI exits. Parent PID alone is not sufficient: a newly launched shared service can initially remain the CLI's child.

## Acceptance evidence

| Contract | Tests |
| --- | --- |
| Desktop edits all eight fields, keeps disabled controls usable, reorders groups, saves, reloads, resets | `tests/host/setup-ui.test.ts` |
| Ordinary shared-service and standalone CLI edit all eight fields and reopen saved values | `tests/host/preferences.test.ts`, real PTY driver `terminal.py` |
| Normal project discovery; inline and global JSON/JSONC; string/object plugin references; unrelated plugins directory | `tests/host/preferences.test.ts` |
| Installed Git reference, not a simulated local-source type; prebuilt package and no dependency preparation | `tests/host/git.test.ts`; packed-install gate recorded below |
| Missing and wrong HTTP credentials receive **401** without file creation | `tests/host/preferences.test.ts` |
| Empty password still requires host-generated credentials | `tests/host/preferences.test.ts` |
| Different inherited options across locations; two server processes sharing one config root; distinct roots | `tests/host/persistence-activation.test.ts` |
| Restart, manual atomic replacement, file deletion, stale drafts, unknown members, malformed/future documents | `tests/host/persistence-activation.test.ts`, `tests/preferences-store.test.ts` |
| Numeric-null startup/manual replacement refusal, unrelated-Save rejection, explicit repair | `tests/host/persistence-activation.test.ts`, `tests/preferences-runtime.test.ts`, `tests/setup-service.test.ts` |
| Last-model removal writes `models: null`; reset restores inherited models | `tests/host/persistence-activation.test.ts`, `tests/setup.test.ts` |
| Equal-value reset changes origin and active revision without requiring a new engine version | `tests/setup.test.ts`, `tests/preferences-runtime.test.ts` |
| Server path/field allowlists, payload size, safe errors, client/location binding, no client filesystem/socket operations | `tests/setup-service.test.ts`, `tests/setup-rpc-api.test.ts`, native RPC cases |
| One production Save after a committed-but-lost reply; readback reconciles intent and activation | `tests/host/persistence-activation.test.ts`; test-only fetch proxy drops the real HTTP response |
| Real server filesystem write failure preserves active bytes; readable unwritable files remain inspectable | `tests/host/persistence-activation.test.ts` |
| Atomic staging, strict UTF-8/size/duplicate-key checks, ownership/link/ACL refusal, private backup, write/fsync/backup/commit failures | `tests/preferences-store.test.ts` |
| Administrative precedence and uncheckable-policy refusal | `tests/preferences-store.test.ts`, `tests/preferences-runtime.test.ts`; fixture-owned administrative paths |
| Composer stays untouched; old suggestion/offer and late replies cannot reappear; activation creates no surprise prediction | `tests/host/setup-ui.test.ts`, `tests/host/lifecycle.test.ts`, `tests/client.test.ts`, `tests/controller.test.ts`, `tests/preferences-runtime.test.ts` |

Native settings cases check zero provider calls and unchanged OpenCode bytes. Service/runtime unit fixtures additionally count session, conversation-context, generation, and PR-context calls, all zero for settings operations.

## No-lock crash and race evidence

`tests/preferences-store.test.ts` uses the production store in independent Node subprocesses:

- Both writers can pass their revision checks before replacement. Both may succeed, and one can lose the other's different-field edit.
- Concurrent first creation produces a complete JSON document, not a merged or partial document.
- SIGKILL before replacement leaves old bytes intact; SIGKILL after replacement leaves the complete new document.
- A fresh process reads actual persisted state and saves another change without removing files, acquiring a lock, or replaying the interrupted transaction.
- Cleanup removes only the current transaction's staging files. Another writer's abandoned staging files do not prevent Save.

Atomic replacement prevents partial documents, not lost updates. The backup is a last-writer-wins snapshot, not guaranteed recovery of concurrent edits. These limitations are accepted behavior, not an unresolved locking defect.

## Retirement

Removed the shared-OpenCode-config writer, native socket transport, Desktop main IPC bridge, local-origin/standalone guards, their obsolete tests, and the old write-injection probe.

Replacement coverage precedes retirement. `src/config-edit.ts` and the explicitly historical persistence candidate remain for research; their locking and JSONC-editing results do not describe the production preferences store. The historical subprocess worker now calls that historical candidate.

The native observer bundles ordinary dependencies rather than assuming Desktop shares `jsonc-parser`. This fixes the test harness, not the production GUI bundle.

## Gate record

- Focused Desktop: **5/5**, no skips.
- Focused normal/server/CLI preference workflows: **6/6**, no skips.
- Focused compatibility: **9/9**, including a real kernel write-failure case.
- Focused lifecycle: **6/6**, no skips.
- Focused Git install and Save: **1/1**, no skips.
- Whole unit suite after retirement and lost-reset policy regression: **464/464**, no skips.
- Typecheck, bundle, and `git diff --check`: pass.
- Consolidated native/research rerun: **52/52**, no skips.
- Packed-install gate: pending at this checkpoint.

## Limits

- No native Linux or Windows qualification. Path semantics are unit-tested; this is not proof of native filesystem/ACL compatibility.
- No system administrative files were created or changed. Administrative behavior is tested using real fixture-owned paths in the production store.
- OpenCode 2.2.6 generates a password for HTTP serve, including an explicitly empty password setting. An actually unauthenticated HTTP host was therefore not available for native qualification. The plugin adds no authentication layer; any caller admitted by another host's access policy inherits that host's preference access.
- No merge, push, version change, or publication is included.
