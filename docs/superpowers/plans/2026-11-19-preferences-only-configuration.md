# Preferences-only Configuration Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. Track progress with the checkboxes below.

**Goal:** Make server-owned `predictions.json` the only prediction configuration source, with no legacy import.

**Architecture:** Remove host options from runtime resolution and remove settings inheritance from the RPC and both clients. Keep context-file path changes at the server filesystem boundary because Setup RPC is available to remote clients.

**Tech Stack:** TypeScript, Node test runner, OpenCode plugin RPC, existing Desktop and CLI controls.

**Spec:** [Preferences-only configuration](../specs/2026-11-19-preferences-only-configuration-design.md)

## Global Constraints

Keep storage paths, document version, administrative refusal, strict validation, atomic replacement, stale checks, and no replay. Do not edit user OpenCode files, add dependencies, or import options.

## Review Focus

- Different location options must not affect defaults, preference revision, or activation.
- Reset must not revive old models, nor change server-only context paths.
- Rejected context-path RPC writes must not touch disk.
- Mixed-version clients must never obtain writable Setup snapshots, and Save must reject stale revisions from the old contract.
- Both clients must show the server's repair instructions when Save rejects a context-file path.
- Existing null model preferences remain valid; malformed numeric preferences do not activate.
- Existing context and prediction behavior stays covered through installed fixtures seeded via `predictions.json`.

## Tasks

- [x] Add failing real-server and service assertions for ignored plugin options and server-only path handling. Cover reset in the real-server and editor suites.
- [x] Simplify preference resolution, runtime, setup snapshot, and RPC. Keep context-file reads server-configured and validate the path.
- [x] Update reset and provenance in Desktop and CLI, feedback, docs, and tests. Seed installed fixtures through preferences rather than plugin options.
- [x] Address review: version Setup reads and revisions, and show server-only context-file errors on Save.
- [x] Verify unit, typecheck, bundle, package and installed tests. Review the final diff.
