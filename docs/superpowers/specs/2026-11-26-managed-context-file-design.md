# Managed context file — design

## Intent

The standing context file (`contextFile`) is hard to set up. Today the user must find `predictions.json` on the OpenCode server, add an absolute path by hand, create the file, and learn about mistakes only when a prediction fails. The Settings row is a single note ("Set contextFile in predictions.json on the OpenCode server…") and does not even say whether a file is set.

Make it a one-click setting in Desktop and CLI without weakening the rule that protects it.

## The rule this keeps

The app (Desktop or CLI client) can never choose which file the server reads. Setup RPC accepts no file paths (decided in `2026-11-19-preferences-only-configuration-design.md`): a remote client could otherwise direct the server to send any private file to a model. This design adds no path input anywhere. Clients may only ask the server to use one fixed, server-defined file, or to stop using a context file.

## Goals

- Turn the context file on from Settings with one action, without editing JSON.
- Always show whether a context file is set, where it is, and whether it works (readable, size against the 8192-byte limit, valid text).
- Open the file or show it in the file manager when the server is this computer.
- Work on macOS, Linux and native Windows servers, in Desktop and CLI.
- Keep a hand-set `contextFile` path working and visible.

## Non-goals

- Editing the file's contents inside Settings (the host UI kit has no multi-line field).
- Choosing or typing a path from the app, or a file picker.
- Changing how predictions read or use the file (`src/context-file.ts` limits and behavior stay).
- Reset to defaults keeps leaving `contextFile` alone, as today.

## Anti-goals

- Any RPC field that carries a path, a file name or file contents.
- Overwriting or truncating an existing file.
- Returning file contents to a client; status carries only state and byte count.

## Decisions

- **One fixed file.** `predictions-context.md` in the same directory as the server's `predictions.json` (`preferencesPath(host)`'s directory, including `XDG_CONFIG_HOME` and Windows `APPDATA` handling). The name is fixed by the server.
- **Staged like every other setting.** Turning it on or off changes the draft; Save applies it. Save sends `contextFile: "managed"` (use the fixed file) or `contextFile: "none"` (clear the setting) as a top-level save field. No other value is accepted.
- **Applying "managed" on Save, in one transaction.** Creating the file and writing `predictions.json` happen inside the same store write, after its existing conflict rechecks, not as two operations. (Builder check: on Windows the verifier's revision stamp covers the directory chain, so a separate create that makes the directory would turn the following commit into a conflict.) The server creates the fixed file if absent (empty, exclusive create, mode `0600` on POSIX, the verifier's private ACL on Windows), then writes its path into `settings.contextFile`. If anything fails, `predictions.json` is not changed and Save reports why. A file created before a later failure is left in place, empty.
- **Adopting an existing file** (my call). If the fixed file already exists, Save reuses it without changing it, but only when it is a regular file reached without following a link (`lstat`/no-follow), has one link, is owned by the server's user, and is not writable by others (world). Group write is allowed, so files made by hand under a common umask still work. On Windows it must pass the verifier's existing owner and foreign-write check (`Safe`), not the stricter exact-ACL check used before replacing `predictions.json`. Otherwise Save refuses with: "predictions-context.md exists but is not safe to use: <reason>. Fix or remove it, then save again."
- **Which path is stored** (my call). The logical path (`preferencesPath` directory plus file name), not the realpath, written as `~/…` when it is under the server user's home and absolute otherwise. "Managed" means the stored path resolves to the current fixed file, compared case-insensitively on Windows and macOS.
- **Applying "none" on Save.** Removes `settings.contextFile`; the file stays on disk.
- **The file starts empty.** Everything in it is sent to providers, so no instructions or template text go in the file. The row explains what to write.
- **Status is a separate RPC method** (`contextFileStatus`), so older clients that validate `settingsV2` strictly keep working. It reports: `set: false`, or `set: true` with `path` (as stored, for display), `absolute` (resolved on the server, for Open and Show), `managed` (path equals the fixed file), `state` (`ok`, `empty`, `missing`, `too_large`, `invalid`, `unreadable`) and `bytes` when known. The server derives it by reading the configured file with the same reader predictions use, and returns no contents. An older server without the method makes the row say to update the plugin on the server.
- **Open file and Show in Finder** use `ctx.desktop.launch(path)` and `ctx.desktop.reveal(path)`, shown only when `ctx.desktop` exists and the target is this computer (the built-in `sidecar` server). On Windows the button reads "Show in File Explorer"; on Linux "Show in Folder". Remote servers show path and status only.
- **Hand-set paths** show the same status, with Open and Show when local, and "Stop using" to clear the setting. When the set file is missing, the row also offers "Use predictions-context.md instead" (staged `"managed"`, which replaces the setting), so a path that broke after a home rename, an `XDG_CONFIG_HOME` change or a synced `predictions.json` recovers in one step. Otherwise the managed file is offered only while nothing is set.
- **Windows.** File creation on Windows goes through the existing verifier helper (`src/preferences-windows.cs`), which gets one new operation that creates the fixed file in the same verified directory chain, with the same private ACLs it uses for `predictions.json`, using create-new semantics. Status reads use the existing Node reader, as predictions do today.
- **Old server, new client** (my call). The client never sends the new save field to a server that lacks `contextFileStatus`. It decides from that call failing with method-not-found, kept distinct from the existing "server unavailable/starting" retry path. Such a server gets a row with today's text plus "Update the Predictions plugin on the server to manage the context file here." and no actions. Any other status failure is shown as temporarily unavailable, with Check again, never as an old server. (Builder check: the editor's save path swallows server errors, so a rejected save field would surface only as "Changes may have been saved…".)
- **Permissions after creation** (my call). Private permissions are a property of creation only. Editors that save by replacing the file set their own permissions afterwards, and the plugin does not police them. Status does not report permissions.
- **Re-enabling a kept file** (answered in conversation). "Stop using" keeps the file, so any client allowed to edit settings can turn it back on. Its contents are what the user wrote at the server-fixed location. This matches the rule, which is about which file the server reads, and matches other settings a client can already turn on (for example GitHub PR context).

## Desktop row (Settings → Predictions → Advanced → Context file)

```
Not set:   Context file
           Standing notes about you and your work, sent to prediction
           providers with every request. Up to 8 KB of text.        [Use a context file]
Staged:    Context file
           Save will use predictions-context.md. If it already exists,
           its current text will be sent with predictions.           [Undo]
Set, ok:   Context file
           ~/.config/opencode/predictions-context.md · 1,204 of 8,192 bytes
                                         [Open file] [Show in Finder] [⋯ Stop using]
Set, issue: same, with a warning line (icon plus text): "Missing", "Too large: 9,310 of 8,192 bytes",
           "Not UTF-8 text", "Cannot be read"; a missing managed file offers "Create it again" (staged).
Empty:     "Empty — nothing is sent until you add text."
```

Status refreshes when the page loads, after Save, and from a "Check again" action, so it updates after the user edits the file.

## CLI

Advanced → "Context file" opens a menu: a status line (path, state, bytes), then "Use a context file" or "Stop using", staged and applied by Save as on Desktop. No Open or Show.

## Approaches considered

- **A. Status and shortcuts only.** Show status and Open/Show; the user still edits JSON to set the path. Small, but leaves the main chore in place.
- **B. Pick any file with a file chooser.** Easiest for the user, but the server would have to accept paths from clients and cannot tell a local client from a remote one. Rejected: breaks the rule.
- **C. A plugin-managed fixed file (chosen by the user).** One click, no JSON, and the rule holds because the server fixes the path.

The user chose C, kept the rule, and asked for Windows in this change.

## Copy

- Row description (not set): "Standing notes about you and your work, sent to prediction providers with every request. Up to 8 KB of text."
- Staged on: "Save will use predictions-context.md. If it already exists, its current text will be sent with predictions." Staged off: "The context file will stop being used when you save. The file stays on disk."
- README: replace "set it directly in `predictions.json`" guidance with the Settings flow; keep a short manual-setup note for hand-set paths.

## Constraints

- No new dependencies. Node file access stays in server-only modules.
- POSIX creation follows the same safety checks as `predictions.json` writes in `src/preferences-store.ts` (owner, mode, no symlinks, no extra links, macOS ACL check), creates with exclusive-create and mode `0600`.
- The Windows verifier must build with the existing `csc` invocation in `scripts/build.mjs` and pass the existing Windows CI workflows.
- Client and server must run the same plugin version for the new actions; mixed versions degrade with a clear message, never a crash.

## Testing

- Server: save with `"managed"` creates the file once, never overwrites, writes the stored path (`~/…` under home), and leaves `predictions.json` unchanged when creation fails; an existing file is adopted only when it passes the adoption checks (symlink, hard link, FIFO, other owner and world-writable cases refused; group-writable accepted); `"managed"` on a first save with a missing config directory succeeds on POSIX and Windows (no self-conflict); `"none"` removes the setting and keeps the file; any other value or a path is rejected.
- Status: each state, byte counts, no contents in the reply.
- Desktop and CLI: every row state above, staging and Undo, local-only Open/Show, "Use predictions-context.md instead" for a missing hand-set path, and the old-server row (method-not-found, distinct from server-starting retries).
- Windows: verifier unit and host tests for the new operation in the existing Windows workflows.

## Left to the builder

Exact RPC schemas and names beyond those given, how the save field threads through `applyPreferenceChange` and the stores, how the verifier's commit operation carries the create step, and test layout.

## Builder check

One fresh reviewer read this design against the code. Its question (what an existing file must pass) and four of its flaws (Windows self-conflict, stored path brittleness, permissions after creation, old-server detection) are settled above as my calls. Its remaining flaw (a client can re-enable a kept file) was answered in conversation.
