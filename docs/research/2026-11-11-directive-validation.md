# Prediction directive validation — 2026-11-11

## Scope and protocol

The production change replaces only the directive in `src/predict.ts` with the candidate approved in the conversation. Conversation extraction, ordering, UTF-8 budgeting, parsing, fallback, and queue policy remain unchanged. The installation bundles are rebuilt from the current working tree, including pre-existing user changes.

This is a synthetic diagnostic experiment, not a held-out real-user study. The 16 cases in `scripts/directive-cases.ts` were fixed before generation. None of the three few-shot examples is an evaluation case. Cases cover explicitly unfinished work, explicitly forbidden work, unknown and previously specified choices, completed tasks, single and multiple assistant offers, Portuguese, Japanese, explicit French preference, user and assistant injection, grounded artifacts, user-stated plans, marked excerpts, and unrequested verification.

### Arms

1. **baseline:** original directive, copied verbatim as the control.
2. **candidate:** approved production directive, obtained from `buildPrompt`.
3. **reminder:** candidate plus a short reminder after the conversation JSON.
4. **fewshot:** candidate plus three independent examples before the conversation JSON; no trailing reminder.

All arms receive identical conversation JSON, selected/truncated once by the production builder. For the marked-excerpt case, experimental additions can exceed the production builder's 32768-byte total; those arms do not ship. The baseline uses the same selected excerpts rather than exercising its larger available context budget. This controls the wording comparison but is not an end-to-end comparison of the old/new truncation policies.

The experiment requests three independent generations per case/arm/model, 384 requests total. Execution order is randomized and saved in the manifest; concurrency is four. The timeout is 45000 ms, with no silent retries. The installed stateless API accepts only a prompt and model reference: temperature, seed, output-token budget, immutable model version, usage and measured cost are unavailable. All requests explicitly select `#low`; provider defaults govern other settings.

### Models and availability

Five initial free-endpoint smoke calls failed: Inkling 2 Small Free returned 403; Flint 40B Free, DeepSeek V4.1 Flash Free, GLM-5.3-Flash Free and MiniMax M3.1 Flash Free returned 429. No failed smoke output is counted as a valid prediction.

The original-directive smoke succeeded on `opencode-go/deepseek-v4.1-flash#low` and `opencode-go/glm-5.3-flash#low`. These are the two experiment models. The catalog lists input/output rates of $0.15/$0.60 and $0.15/$0.50 per million tokens, respectively; included Go quota is not guaranteed to mean zero cost. The stateless response does not return measured usage or cost.

### Scoring and metrics

Runtime output classification reuses `parseSuggestion`; valid `null` is tracked separately from malformed output and request failure. Strict compliance additionally requires an object with exactly one `prompt` key.

Identical conversation/prediction pairs are deduplicated for semantic review, assigned random IDs, and shuffled. Blinded reviewers receive only those IDs, conversations, and predictions: no model, directive, arm, repetition, latency, or case expectation. Repeated outputs retain their frequency when scores are mapped back to trials.

The review packet groups identical conversations to avoid repeating them. Two runs of meaningless synthetic `padding ` are abbreviated only in the review packet; all meaningful text and marked-excerpt boundaries remain. Predictors received the full production-selected excerpts. Astra (`openai/gpt-6-astra`) and Fable 5.2 (`claude-agent/claude-fable-5-2`) independently score the same packet. Neither receives the experimental directives or the other review. The rubric covers likely intent, edit effort, unsupported assumptions, language preference, and whether null is appropriate. These are model judgments, not measured user acceptance.

Report useful non-null precision and useful coverage separately. Also report non-null coverage, valid-null rate, unsupported-assumption rate, language adherence, invalid output, request failures, strict JSON compliance, and response p50/p95 latency. An always-null reference has zero useful coverage and undefined non-null precision; abstention alone cannot win this comparison.

Semantic review is still judgment, not proof of the user's actual next prompt. Synthetic expectations, model judges, small case count, nondeterminism, and correlated repetitions limit generalization. Do not interpret three repeats of one history as three independent histories. Results should be reported per model and with case-cluster uncertainty rather than trial-level confidence claims.

The case set emphasizes explicit unfinished requests versus unsupported continuations. The evidence-focused rubric can reject plausible curiosity-driven follow-ups, such as asking for a deeper explanation. It therefore does not measure every kind of useful real-world prediction. Usefulness and unsupported details are separate judgments: a small removable invented detail can coexist with a prediction otherwise usable with light edits. Both rates must remain visible.

## Reproduction

```sh
node --test tests/directive-experiment.test.ts tests/predict.test.ts
node scripts/directive-experiment.ts \
  --models 'opencode-go/deepseek-v4.1-flash#low,opencode-go/glm-5.3-flash#low' \
  --repeats 3 \
  --output .test-artifacts/directive-validation-2026-11-11
```

Use a new output directory for a new run; the manifest is created exclusively to avoid overwriting evidence. `--dry-run` resolves models and reports planned calls without generating predictions. Raw prompts, request order, settings, responses, failure names/statuses, latency, and blinded review packets are local files under the output directory. No private conversations or credentials are written by the experiment.

## Results

All 384 generation calls completed. Every response met the strict one-key JSON contract; no request failed or timed out. Deduplication produced 147 distinct semantic review rows. Both reviewers returned all 147 IDs, which were independently validated before aggregation.

The table uses conservative joint judgments: a suggestion is useful only if **both** reviewers say so; unsupported assumptions count if **either** reviewer flags them. Language correctness likewise requires agreement. This rule was implemented before scores were available. Scores retain trial frequency after deduplication.

**Precision** is useful suggestions divided by non-null suggestions. **Useful coverage** is useful suggestions divided by all 48 attempts in that model/arm. **Unsupported** is the share of non-null suggestions with unsupported details or scope; speculative but factually grounded questions can be unhelpful without being unsupported.

| Model (`#low`) | Arm | Suggestions | Useful | Precision | Useful coverage | Unsupported | Null rate | Latency p50 / p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DeepSeek V4.1 Flash | baseline | 47 | 23 | 48.9% | 47.9% | 38.3% | 2.1% | 5.468 / 12.447 s |
| DeepSeek V4.1 Flash | candidate | 28 | 24 | 85.7% | 50.0% | 0.0% | 41.7% | 5.440 / 10.095 s |
| DeepSeek V4.1 Flash | reminder | 28 | 24 | 85.7% | 50.0% | 0.0% | 41.7% | 5.466 / 16.489 s |
| DeepSeek V4.1 Flash | fewshot | 24 | 24 | 100.0% | 50.0% | 0.0% | 50.0% | 4.802 / 8.796 s |
| GLM-5.3-Flash | baseline | 48 | 23 | 47.9% | 47.9% | 47.9% | 0.0% | 1.342 / 2.283 s |
| GLM-5.3-Flash | candidate | 38 | 24 | 63.2% | 50.0% | 34.2% | 20.8% | 1.467 / 2.983 s |
| GLM-5.3-Flash | reminder | 36 | 24 | 66.7% | 50.0% | 25.0% | 25.0% | 1.213 / 2.196 s |
| GLM-5.3-Flash | fewshot | 30 | 24 | 80.0% | 50.0% | 13.3% | 37.5% | 1.355 / 2.286 s |

Strict JSON compliance was 100% in every row. Candidate/reminder/few-shot language adherence was 100% among non-null predictions. The DeepSeek baseline had one Spanish prediction for a Portuguese conversation, giving 97.9%; the GLM baseline had 100% language adherence.

The always-null reference has 0% useful coverage, undefined non-null precision, and 100% null rate. Its predeclared appropriate-abstention rate is 50%, because eight cases support a follow-up and eight expect abstention.

### Interpretation

- **The candidate mainly improves selectivity, not the number of useful predictions.** Each model produced 24 jointly useful candidate predictions versus 23 baseline predictions. The candidate removes many weak or unsupported suggestions while retaining every sample in all eight predeclared positive cases.
- Every candidate abstention was appropriate according to both reviewers. No candidate abstention missed one of the eight strongly supported follow-ups in this set.
- DeepSeek benefits more than GLM. Under the candidate, DeepSeek still produced four speculative follow-ups that the reviewers did not jointly endorse; none introduced unsupported details. GLM still produced fourteen non-useful suggestions, thirteen of which included unsupported choices or scope.
- A trailing reminder adds little here: no jointly useful coverage gain over the candidate, a small GLM precision gain, and a higher DeepSeek p95 latency. These latency samples do not establish a reliable speed ranking.
- Few-shot examples show the best selectivity on these diagnostics without sacrificing the eight strongly supported cases. They remain experimental: the dataset is small, the rubric rewards the behavior those examples demonstrate, and the long-input arm exceeds the production byte budget. The approved candidate remains the shipped directive, unchanged after seeing the scores.

### Reviewer disagreement and uncertainty

The reviewers disagreed on at least one semantic field in 10 of 147 distinct rows (6.8%). The differences chiefly concern whether natural explanatory follow-ups or declining an assistant offer are sufficiently supported. One row asks for a Japanese example in Python: Fable considers deletion of the invented language preference a small edit; Astra does not endorse its usefulness. Both can still flag unsupported detail independently of edit effort.

Per-reviewer candidate precision is **85.7–96.4%** for DeepSeek and **63.2%** for GLM. Baseline precision is **48.9–51.1%** for DeepSeek and **47.9–50.0%** for GLM. The conservative table avoids selecting whichever rater favors an arm.

A paired case-cluster bootstrap (10,000 resamples; seed `20261111`) gives a candidate useful-coverage difference of **+2.1 percentage points**, with a diagnostic 95% interval of **0.0 to +6.25 points**, for each model. Only one history improves and fifteen tie per model under the conservative score. The interval includes zero and does not account for synthetic case-selection bias or judge bias. There is no demonstrated broad useful-coverage improvement.

### Representative remaining failures

- GLM chose `XLSX` when no user format preference was supplied.
- GLM suggested `Run the checks now.` after the user explicitly said not to run checks.
- GLM accepted a page-restyling offer even though the user only requested an explanation.
- DeepSeek asked to see cache-key code after an explanation was already complete. Astra considers that a useful elaboration; Fable considers it speculative. Conservative aggregation rejects it without treating it as an invented fact.

Neither exact injected canary (`CANARY-731`, `CANARY-952`) appeared as the predicted prompt in any of the 48 injection-case trials. This is a narrow diagnostic result, not a general injection-resistance guarantee.

## Verification and artifacts

- `npm test`: 130 tests passed, zero failures (126 before the task).
- `npm run typecheck`: passed.
- `npm run bundle`: passed; installation bundles include the new directive.
- `npm run test:package`: passed.
- A fresh code reviewer found no Critical, Important, or Minor code findings and separately checked shared contexts, parser agreement, byte budgets, and always-null behavior. Semantic results were assessed independently by the two blinded raters.
- Existing Node FFI experimental warnings remain. No host GUI/browser integration run was added because the runtime change is directive text only.

Local evidence is in `.test-artifacts/directive-validation-2026-11-11/` (ignored by git): `manifest.json`, `trials.jsonl`, `results.json`, `blind.json`, `review-packet.json`, `review-rubric.md`, both `scores-*.json`, `scored-summary.json`, `disagreements.json`, and `analyze.ts`. The analysis validates complete unique IDs and score types before calculating results; rerun it with:

```sh
node .test-artifacts/directive-validation-2026-11-11/analyze.ts
```

No source code was changed in response to the scores. The validation stage did not commit changes, add telemetry, change queue policy, or study private conversations. Provider costs remain unmeasured. The next quality study should use consented held-out histories, including natural follow-up questions and genuine stopping points, before adopting the few-shot variant or claiming real-user acceptance gains.

## PR integration check

After the user requested a PR and merge, the seven task-owned source, test, and documentation files were copied into an isolated branch based on `origin/main` at `ee6db84` (through PR #11). No unrelated files or dirty bundles were copied from the development checkout. Installation bundles were regenerated from that clean integration state. The original checkout and its unrelated edits were left untouched.

The integration branch passes 158 tests, type checking, bundling, and the package check. The increase from the earlier 130 tests comes from newer changes already merged to main. The production prediction builder and parser are unchanged on that base, so the saved directive experiment remains applicable; no additional model calls were made for PR preparation.

`npm ci --ignore-scripts` reports existing dependency advisories: 24 moderate and one high-severity package, Vite. Dependencies and lockfile are unchanged by this PR. Those inherited dependency issues are outside the directive change and were not silently fixed or omitted from the PR notes.
