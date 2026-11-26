# Windows prediction preferences qualification

[Native CI run 45750312398](https://github.com/fcoouto/opencode-predictions/actions/runs/45750312398) tested commit `61bca4b`. Both jobs ran OpenCode `2.2.6` on Windows `10.0.26100.0` under a fresh standard-user account on local NTFS.

Both jobs installed the same npm release candidate, including `dist/predictions-verifier.exe`, with install scripts disabled. The archive SHA-256 was `911a282c924ed77ad500af73445cbcaf2f1553f8a449125c356166832184d911`. The tagged release workflow builds and tests an archive in the release run before publishing those same bytes. No package was published by this qualification run.

| Fresh-profile order | First settings read | Slowest poll pair | Native tests |
| --- | ---: | ---: | ---: |
| `%APPDATA%` first | 112 ms | 150 ms | 29 passed, 0 skipped |
| `XDG_CONFIG_HOME` first | 88 ms | 100 ms | 29 passed, 0 skipped |

## What passed

- Packaged server RPC: both config roots loaded writable, saved, preserved unknown members, made a backup, and reloaded after restart. The override path included spaces, an apostrophe, brackets, and non-ASCII characters. Reads created no settings files; no provider calls or OpenCode configuration changes occurred.
- Direct NTFS tests used verifier bytes from the installed archive. Tests covered ownership, ACL and link refusals, read-only files, administrative precedence, private empty staging files, stale revisions, directory pinning, and failures before and after replacement.
- Two clients polled every 2 seconds for 30 seconds. Each runner observed at most two concurrent verifier processes and none after polling stopped. The existing 1,800 ms verifier, 2,000 ms settings read, and 12,000 ms Save deadlines were unchanged.

The [pre-change baseline](https://github.com/fcoouto/opencode-predictions/actions/runs/45725431297) reproduced the original ownership refusal on both paths. The [precompiled experiment](https://github.com/fcoouto/opencode-predictions/actions/runs/45747428311) staged its verifier separately; only the release-candidate run qualifies the npm package.

## Scope

Windows qualification covers the x64 OpenCode server on local NTFS with the packaged verifier. It does not cover the Windows Desktop UI, native ARM64, Git installs without the verifier, network shares, redirected network profiles, junctions, or symlinks in the preferences path. Native Linux filesystem behavior is not qualified by this run. See the [macOS evidence](2026-11-18-predictions-preferences-qualification.md) for earlier qualification.
