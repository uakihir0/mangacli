English | [日本語](README.ja.md)

# mangacli Specification

mangacli is a TypeScript npm library and CLI that renders finished Japanese-style manga pages, in black-and-white or color, from a manga structure declared in YAML or as a TypeScript object. It is licensed under MIT.

This directory contains the full specification: features, document format, rendering algorithms, API, CLI, validation, quality criteria, and the development plan. **The specification documents themselves are written in Japanese.**

## Documents

| No. | Document | Contents |
|---|---|---|
| 1 | [01-overview.md](01-overview.md) | Purpose, goals and non-goals, use cases, design principles, glossary, feature list |
| 2 | [02-architecture.md](02-architecture.md) | System overview, processing pipeline, display list (IR), backends, technology choices, determinism, security |
| 3 | [03-document-format.md](03-document-format.md) | YAML document structure, value types, units, coordinate systems, references, style cascade, shorthands |
| 4 | [04-pages-and-panels.md](04-pages-and-panels.md) | Page sizes, bleed, base frame, binding, spreads, panel layout, borders, bleed panels, reading order, draw order, page numbers |
| 5 | [05-elements-and-images.md](05-elements-and-images.md) | Common element properties, placement, clipping and frame-breaking, image assets, filters, shapes, fills, groups |
| 6 | [06-balloons.md](06-balloons.md) | Speech balloon shapes, strokes, tails, auto sizing, placement, connected balloons, dialogue shorthand, auto placement |
| 7 | [07-text.md](07-text.md) | Typesetting (vertical and horizontal), fonts (including the font catalog and on-demand download), mixed fonts, line breaking rules, ruby, emphasis dots, tate-chu-yoko, inline markup, hand-lettered SFX |
| 8 | [08-effects.md](08-effects.md) | Focus lines, flashes, speed lines, lightning and other overlay effects, screentones, gradients, manpu marks, scattering |
| 9 | [09-hand-drawn.md](09-hand-drawn.md) | Hand-drawn rendering engine: wobble, pen pressure, tapering, stroke decomposition, pens, finishing |
| 10 | [10-color-and-output.md](10-color-and-output.md) | Color modes, monochrome conversion, tone rendering, output formats, resolution, crop marks, profiles, separations |
| 11 | [11-api.md](11-api.md) | TypeScript API, types, renderer, resolvers, plugins |
| 12 | [12-cli.md](12-cli.md) | CLI commands, options, configuration file, exit codes |
| 13 | [13-validation.md](13-validation.md) | Validation stages, diagnostic format, list of diagnostic codes |
| 14 | [14-quality.md](14-quality.md) | Test strategy, acceptance criteria for the hand-drawn look, performance targets, compatibility |
| 15 | [15-roadmap.md](15-roadmap.md) | Milestones, decisions, open questions |
| 16 | [16-grammar.md](16-grammar.md) | Appendix: formal grammar (EBNF) of string values such as lengths, paints, strokes, filters, page ranges, file name templates, and inline markup |
| - | [examples/](examples/) | Sample documents (minimal, B5 monochrome manuscript, color 4-panel strip for social media) |

## Conventions

- Requirement levels follow MUST / SHOULD / MAY. In Japanese they appear as 「〜しなければならない」「〜すべきである」「〜してもよい」.
- Each feature has a priority:
  - **P0**: required for the first release (MVP).
  - **P1**: implemented by v1.0.
  - **P2**: candidate after v1.0. The data format may only reserve the key.
- **Numeric defaults are provisional.** They will be tuned while building sample pages during milestone M1, then frozen as `engine: 1` (decision D-24 in [15-roadmap.md](15-roadmap.md)).
- Length examples assume B5 (182 × 257 mm) unless stated otherwise.

## Suggested reading order

| Reader | Order |
|---|---|
| Authors writing YAML | 01 → 03 → 04 → 06 → 07 → 08 → examples |
| Library implementers | 01 → 02 → 03 → 09 → 04–08 → 10 → 11 → 13 → 14 |
| Developers embedding the API | 01 → 11 → 03 → 10 → 13 |
| CLI users | 01 → 12 → 03 → 10 |
