# Feature catalogs

The ten YAML pages correspond to docs/14 §14.3.1. They cover balloon shapes,
tails and connections, vertical/horizontal text, panel layouts, effects,
tones, marks, hand/pen presets, and color/gray/black paints. They use a fixed
seed and 72 dpi preview PNGs to keep the suite small.

`npm test` compares display-list structure and strings exactly and each
numeric value within ±0.001 mm, on every platform and Node version.
It also composes each page twice and requires exact determinism.
The same display-list baseline is intentionally required on Node 24 and 26.
PNG SHA-256 hashes are checked only on Linux x64.

To deliberately regenerate committed baselines on Linux x64:

```sh
npm ci
npm run test:update
```

Review the YAML and display-list changes before committing the updated
baselines. JSON files use LF and numeric JSON values (no locale formatting).
PNG metadata is disabled to avoid embedding source paths or source hashes.
Missing baselines fail ordinary tests; CI never updates them automatically.
Fonts come from the repository's pinned, hash-verified catalog, not system fonts.
