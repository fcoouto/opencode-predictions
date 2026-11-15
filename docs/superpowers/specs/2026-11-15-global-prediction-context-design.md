# Global prediction context

## Intent and approval

The user approved one optional text/Markdown file shared across projects and requested implementation. It supplies stable preferences and work constraints to prediction requests without replacing the predictor contract.

## Approaches

- **Selected: explicit global `contextFile` option.** An absolute or `~/` path names one user-owned file on the OpenCode server. Configure it in the existing global plugin entry.
- Inline configuration text is awkward for maintained Markdown.
- Project discovery, project files, layered context, and automatic `AGENTS.md` ingestion are excluded.

## Behavior

- No configured file preserves existing prompts and behavior byte-for-byte.
- Read a UTF-8 regular file with a maximum size of 8192 bytes. Reject invalid UTF-8, binary control characters, directories, unavailable files, and oversized files. Never silently truncate or ignore a configured file.
- Empty or whitespace-only files add no guidance.
- Snapshot the file before the first model call in a prediction cycle. Reuse it for error fallback, automatic escalation, and manual alternatives. New cycles reread the file. Metadata-only refresh does not read it.
- Existing cached suggestions remain unchanged. A new completion or plugin reload permits a fresh snapshot. With escalation off, each explicit refresh starts a new cycle.
- JSON-quote guidance before the existing conversation boundary. Keep the entire prompt within 32768 UTF-8 bytes, reducing conversation history/excerpts using existing budgeting.
- Standing guidance may inform relevant preferences and constraints, but cannot create work or override current explicit user intent. Preserve JSON output, valid abstention, parser, and Tab behavior.
- A file error returns a fixed actionable notice before any model call and does not affect rankings or cooldowns. Cancellation and existing timeouts still bound file loading.
- Status reports the configured path and last outcome, never file contents or raw filesystem errors.

## Scope and constraints

Use the existing option parser, service cycles, prompt builder, notices, and status display. Keep Node filesystem access in a server-only module; clients also import the service module. No dependencies, watchers, telemetry, project-relative paths, or changes to the user's actual global configuration.

The host supplies effective plugin options; this feature adds no independent project override or merge system. Enforcing the origin of host options is outside this release.

## Privacy and proof

Every attempted model, including fallback providers, receives the configured guidance. Document this changed privacy boundary and warn against secrets. Model instruction compliance remains best-effort.

Tests cover option validation, bounded real file reads, safe serialization and Unicode budgeting, absent/empty parity, cycle snapshots, reload/new-cycle behavior, failures and recovery, cancellation, metadata refresh, notices, and server/client bundle compatibility. Run the full suite, type checking, bundling, and package checks. No paid model experiment or real user history is required for implementation verification.
