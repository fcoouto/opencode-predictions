# README Product Showcase Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this documentation-only plan in the current session.

**Goal:** Make the README visually compelling, searchable, and easier to use without changing product claims.

**Architecture:** Keep the README self-contained as GitHub-flavored Markdown with one local SVG interaction diagram. Preserve detailed reference content in native disclosure elements.

**Tech Stack:** Markdown, GitHub-supported HTML, SVG, existing Node test tooling.

**Spec:** `docs/superpowers/specs/2026-11-14-readme-showcase-design.md`

## Global Constraints

- No runtime, dependency, configuration-default, or compatibility changes.
- No fabricated claims, screenshots, translations, or GitHub metadata edits.
- Preserve installation snippets, costs, privacy, and compatibility limitations.
- Work only on `docs/readme-showcase`; leave the proposal unmerged.

## Review Focus

- Small screens: no clipped introduction, image, or navigation.
- Light and dark themes: image and badges remain legible.
- Existing configurations: instructions preserve other plugins and settings.
- Advanced users: all prior reference content remains reachable.
- Distribution: the README and its local image remain available in the packed package.

---

### Task 1: Build and verify the README showcase

**Files:**
- Modify: `README.md`
- Create: `readme-demo.svg`
- Modify: `package.json` (include the README image in packaged files)
- Modify: `tests/package.test.mjs` (assert image inclusion)
- Existing checks: `tests/package.test.mjs`, `tests/*.test.ts`

**Interfaces:**
- Consumes: current README claims, configuration examples, and package file-list behavior.
- Produces: a GitHub-compatible README and one accessible, static interaction diagram.

- [x] Read current README, package configuration, workflows, and README-dependent tests; confirm worktree isolation.
- [x] Record approved design and this plan.
- [x] Verify baseline tests after `npm ci --ignore-scripts`.
- [x] Add a packaging assertion for the README image and observe its failure before adding the asset.
- [x] Add the SVG and restructure the README; keep technical reference text and fenced examples intact.
- [x] Check Markdown links, anchors, disclosures, configuration blocks, SVG validity, and package inclusion.
- [x] Inspect desktop/mobile renders in light/dark themes; fix observed issues together.
- [x] Run existing tests and package checks; review the final diff for unrelated churn.
- [x] Leave the branch ready for user review without pushing or merging.

## Verification Evidence

- `npm test`: 217 passed after installing locked dependencies.
- `npm run test:package`: the new image-inclusion assertion failed before implementation and passed afterward.
- Local checks confirmed unchanged fenced examples, settings rows, advanced reference, privacy, and compatibility text.
- GitHub-style Chromium renders at 1280 px and 375 px passed image, anchor, disclosure, and page-overflow checks in both light and dark themes.
- SVG XML, accessible title/description, and `git diff --check` passed.
