# White outline print-mono goldens

Regenerate intentionally with Node 24 and the repository's installed fonts:

```sh
source ~/.nvm/nvm.sh
UPDATE_GOLDEN=1 npm test -- test/outline-golden.test.ts
```

The three 400×500, 127 dpi, 1-bit PNGs cover fixed/adaptive outlines, double
outlines with dakuten and closing, role defaults and wedge/bubble/line halos.
The photo-like grayscale gradient/noise is seeded and generated in memory by
`test/fixtures/outline.ts`; no network or external image is used.

Comparison allows at most 0.5% changed pixels (binary values must still be
0/255), enough for minor rasterizer edge differences, not a missing outline.
Separate geometry-derived readability assertions require at least 95% white
in the inner outline ring and 95% black in glyph interiors for every role and
background. Regeneration does not bypass these assertions.
