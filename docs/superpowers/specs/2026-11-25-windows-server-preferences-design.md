# Native Windows server preferences

Status: independently reviewed, revised, and approved. After the native experiment, the user approved packaging the precompiled Windows x64 verifier and testing the exact release archive.

## Intent and scope

Let OpenCode servers running natively on Windows load and save prediction preferences from the same Desktop and CLI clients. Keep the existing `predictions.json` format and location: `%APPDATA%\opencode\predictions.json`, or an explicit absolute `XDG_CONFIG_HOME` override. Selection remains server-side. No migration, client or RPC changes, OpenCode configuration edits, or POSIX behavior changes.

Start with x64 Windows servers using local, drive-qualified NTFS paths and the npm release. Do not treat a rooted path without a drive letter as absolute. Native ARM64, Windows Git installs without the built verifier, network shares, redirected roaming profiles on shares, device paths, and directory aliases through symlinks or junctions are out of scope. Update compatibility notes only after native verification of the actual package. Do not broaden the Linux claim.

## Approaches

- **Windows PowerShell and .NET prototype:** kept file compatibility without a binary, but repeated native runs timed out on packaged OpenCode reads.
- **Precompiled Windows x64 verifier (selected after testing):** uses the same .NET and Win32 checks without launching PowerShell. Build it in Windows CI; do not check in a binary or compile on install. [The experiment](https://github.com/fcoouto/opencode-predictions/actions/runs/45747428311) used a sidecar and does not qualify the release archive.
- **OpenCode plugin storage:** avoids direct file checks, but changes manual editing and recovery and requires new storage and compatibility decisions. Do not use it for this change.

## Design

Keep the existing store as owner of the transaction. Replace Unix ownership and mode checks only on Windows. Use Windows security identifiers (SIDs) from the server account and filesystem descriptors, not names, localized output, or Node's synthetic `uid` and `mode` bits. Launch the installed verifier beside the server bundle; never search the workspace or `PATH`. Do not bypass enterprise execution policy. Send bounded input through the isolated child environment, scrub it before processing, and never use command arguments or temp files for preference data. Bound time and output, propagate cancellation, and never return raw helper errors to clients. Do not cache ACL decisions across transactions or status polls.

Build one npm archive on Windows per CI run. Both fresh-profile native jobs verify its digest and install the same bytes. On a release tag, publish that tested archive, not a new archive packed by the publish job. A missing or unsupported verifier fails closed. No install-time build or new package dependency.

Verify the local volume and walk the chain from the volume root without following reparse points. The preferences directory and files must be owned by the server account. Ancestors may also be owned by Local System, built-in Administrators, or Windows Modules Installer (`TrustedInstaller`). These are the trusted principals for ancestor modifications; on the preferences directory and files, trust only the server account, Local System, and built-in Administrators. Use SIDs, not localized names, to enforce these rules. Reject grants that let other principals change data, ACLs, ownership, or replace relevant entries. Include inherited grants and parent delete-child rights. Ordinary access to traverse ancestors or create unrelated siblings must not disable default `%APPDATA%` use. Refuse ambiguous security descriptors or access rules that the verifier cannot safely interpret.

Bind verification to filesystem objects. Pin each verified directory until the operation finishes so it cannot be replaced between verification and use. Verify the active file's identity and permissions on the object opened for data access. Refuse symlinked, hard-linked, reparse-point, or nonregular active files or backups. Keep staging and replacement under the pinned, verified directory. Reject changed identities or security at the existing precommit checks. If the runtime cannot provide these guarantees, fail closed rather than falling back to a separate pathname-only ACL check. Check `%ProgramData%\opencode` before using preferences. An existing administrative source or unknown/uncheckable administrative path remains managed and suppresses user preferences.

Evaluate the server account's file write access separately from its ability to replace an entry through the parent. Honor a file's read-only attribute and deny Save if the account cannot write the existing file, even if replacement is technically possible. A verified readable file stays active in that case.

### Save policy after parity review

Use the Unix risk model: preserve ordinary access permissions, keep staging and backups private, and accept best-effort revision checks and last-writer-wins. Do not try to rewrite or merge an arbitrary Windows ACL. Replace an existing active file or backup only if its verified discretionary permissions match the private file policy used for new files. Extra or narrower grants are read-only for an otherwise readable active file. Decide active-file eligibility from the same open file that supplies the revision and bytes. Refuse replacement of an EFS-encrypted active file or existing backup before writing preference bytes to staging.

Save does not preserve all filesystem metadata. Keep the existing refusal of detectable unsupported integrity or access policies, but do not require privileged audit ACL inspection or guarantee preservation of opaque audit metadata. This limit matches the Unix store's metadata guarantee and must not prevent repeat Save on ordinary app-created files.

Retain exclusive same-directory staging, bounded UTF-8 validation, file sync, backup, stale-draft checks, atomic replacement, and postcommit readback. On Windows, stage files with verified private ACLs **before** writing preference bytes. Do not loosen an existing file's ACL or alter an existing OpenCode directory's ACL. If protections cannot be established before commit, leave the active bytes unchanged and return a safe reason. If replacement succeeds but readback fails or observes different bytes, use the existing uncertain outcome and require a fresh read before another Save. Do not retry, roll back, or claim success. Directory pins protect path identity; they do not serialize writers. No save locks, auto-repair, or new authentication. Concurrent writers retain the existing last-writer-wins risk, not permission to operate on an unverified path.

## Native acceptance

- On a Windows CI runner using a regular user profile on NTFS, exercise `%APPDATA%` and the explicit config-root override. Prove that read-only inspection creates nothing, first save installs an active file, a later save preserves unknown members and creates a private backup, and a fresh process reloads it.
- Cover refusal of unsafe ownership or write ACLs, inherited mutation rights, unsafe staging or backup ACLs, reparse points and hard links, uncheckable administration, and unsafe path syntax. Attempt a directory swap between verification and use; require the swap to fail or the operation to refuse without touching the substitute. Load a valid read-only file, then attempt Save and verify refusal even when the parent permits replacement.
- Exercise stale drafts and failures on both sides of active replacement. Refusals before replacement must preserve active bytes. A forced readback failure after replacement must return an uncertain outcome while leaving the complete new document on disk. Preserve unrelated OpenCode configuration in both cases.
- Run a native OpenCode server smoke test with the built plugin and an isolated profile. Read settings and save through RPC, verify active revision, then reload from disk. Verify normal reads and saves fit existing client deadlines without generating predictions. Exercise sustained overlapping polls from two clients on the existing interval and verify helper processes do not accumulate. Passing simulated Windows path tests does not qualify Windows.
- Run the existing POSIX checks and bundle/package checks. If native Windows evidence is unavailable, report that explicitly and retain the README qualification caveat.
