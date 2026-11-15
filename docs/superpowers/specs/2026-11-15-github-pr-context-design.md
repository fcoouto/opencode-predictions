# Opt-in GitHub pull-request context

## Intent and authorization

The user approved adding public and private GitHub PR context, opt-in and off by default, with the previously proposed GitHub-only, bounded, cached, fail-open behavior. The user subsequently requested the `includeGithubPRContext` name, live-auth qualifications, and a fresh independent worktree review. Live public reads are authorized; private-access qualification requires a user-selected private PR target. Do not change settings or disclose PR contents to a paid prediction model during qualification. Push, merge, release, and installed-plugin updates are not part of this feature request.

## User-visible behavior

Add `includeGithubPRContext: false` to parsed plugin defaults and technical status. Setting it to `true` permits the selected prediction providers, including fallback models, to receive linked public or accessible private PR title, description, state, draft status, and freshness timestamps.

Only inspect links in the already selected and byte-bounded conversation JSON, after its literal delimiter. Never scan the directive or standing guidance from the global context file. Do not scan discarded turns, compaction summaries, tool output, reasoning, instructions, attachments, or other sessions. Prefer the two most recently mentioned distinct PRs. Fetch no comments, diffs, files, or nested links. Support only explicit HTTPS `github.com/{owner}/{repo}/pull/{number}` links, with optional query/fragment and surrounding Markdown punctuation.

Reject URL matches touching a conversation-excerpt boundary: truncating a PR number must not create a different accessible PR target. Capture model ownership before awaiting enrichment so concurrent catalog removal or transfer cannot authorize a stale generation.

## Retrieval and credentials

Use a new shared server helper. Obtain an existing active github.com credential through `gh auth token --hostname github.com --no-refresh`, with no shell, prompting, account changes, or token persistence. If CLI/auth is unavailable, public requests may proceed anonymously; private failures are omitted.

Pure URL/prompt helpers live separately from the Node credential/retrieval module so shared client service utilities remain browser-bundle compatible.

Construct fixed REST GET endpoints under `https://api.github.com/repos/{owner}/{repo}/pulls/{number}` from validated components. Reject non-GitHub hosts, credentials in links, nondefault ports, malformed paths, and unsafe components. Reject redirects. Never fetch the original arbitrary URL or API URLs supplied by response bodies. Credentials go only in the API Authorization header, never in prompts, logs, notices, or cache keys.

Read responses with a 256 KiB stream limit. Validate the returned PR identity against the requested canonical URL and whitelist metadata fields. Keep titles to 256 Unicode code points and descriptions to 4,096, using marked head/tail excerpts when needed.

## Limits and cache

- One enrichment phase per generation action, not per fallback model.
- At most two API requests and one credential lookup per enrichment.
- Enrichment has a 2,000 ms aggregate deadline, also bounded by the existing request cancellation/deadline.
- Success cache is in memory only: 60-second TTL and at most 64 entries, scoped by session ID and a nonreversible credential fingerprint. No cross-account cache reuse. No stale-on-error fallback or persistent data.
- Failed lookups, invalid/oversized responses, rate limits, and enrichment-only timeout leave the original prediction path usable. Parent cancellation still prevents generation.

## Prompt priority

Do not modify the existing directive, conversation selection, or 32,768-byte total prompt budget. Append a separate JSON block labeled as untrusted reference data, not instructions or execution authorization. GitHub metadata gets at most 8,192 additional serialized bytes, including its label, and only space left after the original conversation prompt. Drop or excerpt PR metadata before sacrificing any human intent or latest assistant response. Mark descriptions that were excerpted. Include source URLs and retrieval/update times.

This improves available evidence; it does not guarantee model obedience or authorize execution. The screenshot's “No execution allowance was granted” must not become execution approval.

## Architecture and alternatives

- **Selected:** validated GitHub REST reads using existing CLI credentials, with optional service callback and separate appended reference block. No new dependency or browser automation.
- **Rejected:** arbitrary URL crawling or recursive expansion; these broaden privacy, SSRF, latency, and prompt-injection exposure.
- **Rejected:** importing arbitrary tool output; that breaks existing conversation filtering.
- **Fallback:** self-contained assistant summaries remain useful, and ordinary predictions continue when enrichment is disabled or unavailable.

Numeric limits, the option name, credential command, and cache scope are implementation choices within the approved behavior.

The independent builder/security review approved this design on base `e895dfb`, including the new concise-prediction and global-context-file features. Preserve both; test delimiter-like text and PR links inside JSON-string standing guidance without fetching them.

## Verification and stop condition

Test default-off zero side effects; strict option validation; public/private fixtures; URL allowlisting, deduplication and newest-first cap; credential isolation; session/TTL/cache bounds; invalid/redirect/oversized responses; cancellation/timeouts; no recursive reads; JSON/Unicode excerpts; no credentials/unrelated response fields in prompts; byte-budget and base-prompt preservation; metadata-only refreshes making no PR reads; and context changes preventing generation.

Use only injected local credential/HTTP fixtures. Run full tests, typecheck, production bundle, package validation, and relevant installed-package checks. Obtain independent design/security and final code review. Stop with a verified local feature branch; leave settings off.
