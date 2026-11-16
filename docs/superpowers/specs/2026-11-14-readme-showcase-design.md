# README Product Showcase

## Intent

Help developers discover OpenCode Predictions, understand its next-prompt suggestions, and install it safely. The user approved the product-showcase direction and requested an isolated worktree for review before merge.

## Approaches

- Minimal polish preserves the existing reference-first structure but does not give the product enough visual presence.
- **Product showcase, approved:** lead with the interaction, then installation and controls, with advanced reference available on demand.
- Graphic-heavy presentation adds maintenance and makes essential information harder to search and read.

## Design

Treat the README as a Read surface with a concise product introduction. Keep the project name as searchable text, describe OpenCode Desktop and interactive CLI support immediately, and show an authored SVG interaction diagram with descriptive alternative text and an explicit illustrative caption. Use a quiet dark editor surface and a restrained green accent rather than invented product branding or generated screenshots.

Add a small badge row, section navigation, short benefits, and a compact controls table. Keep installation examples intact while correcting the existing typo and clarifying the new-config case. Keep safety, compatibility, model-selection, privacy, and cost disclosures visible. Group detailed interaction behavior and advanced settings in native GitHub disclosure elements without deleting reference material.

## Constraints

- No runtime behavior, dependency, configuration-default, or compatibility changes.
- No fabricated usage metrics, endorsements, screenshots, pricing guarantees, or translations.
- Keep essential copy in Markdown rather than only inside an image.
- Use natural English search terms; no keyword stuffing.
- Use a repository-local SVG so pull requests and worktree previews do not depend on an unmerged remote asset.
- No GitHub metadata changes, push, pull request, or merge without a separate request.

## Verification

Check Markdown structure, local links and anchors, preserved configuration examples and technical reference, image alternative text, SVG validity, and package contents. Inspect a GitHub-style render at desktop and mobile sizes in light and dark themes. Run existing tests after installing locked dependencies; do not repair unrelated dependencies as part of this documentation change.
