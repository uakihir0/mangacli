---
name: manga-production
description: Create and revise Japanese right-to-left manga with Sogni panel art and mangacli. Use for storyboarding, generating visually consistent source art, fitting dialogue around the art, or preparing an editorial or print review pass.
---

# Manga production with Sogni and mangacli

1. **Storyboard before generation.** Write the protagonist's desire, the choice that costs them something, and the visible result. Give each panel one job. Read the rough pages with the dialogue hidden: movement, who is in danger, and cause and effect should stay clear. Give a costly choice a beat of hesitation, then stage each step of the action before the visual payoff. In a right-bound chapter starting on the left, the even page is the right half of a facing pair; review the bottom-left panel of the odd page as a page-turn hook.
2. **Design the art and lettering together.** Choose the frame aspect ratio and reserve a specific part of the scenery (sky, fog, blank wall) for each line. Describe that scenery as part of the composition; asking for “empty space” often draws a box. Ask for one full-frame image, no borders, lettering, effects typography, or balloons. Keep a short description and a tight reference crop for each recurring face, costume, and prop. In the prompt say what must stay the same and what camera angle must change. Review contiguous panels for cast, weather, light sources, props, and direction of travel. Check that faces, hands, props, and motion survive the actual `cover` crop.
3. **Generate with one connection per app ID.** Use Node 24 and `npm --prefix sample/tools ci`. Bind `SOGNI_API_KEY` and `SOGNI_APP_ID` through the environment or use the ignored `sample/.env`. Run the daemon in one terminal; enqueue from another. Select panel IDs for rework instead of rerunning the whole chapter. Use a separate candidate directory or `--n 2` so the approved art is not overwritten. See [sample notes](../../../sample/NOTES.md) for the prompt schema, image-edit model and connection recovery.
4. **Letter over the final selected artwork.** Keep vertical dialogue short and in right-to-left order. Record `anchors.mouth` and `regions.face` in source pixels, not cropped panel pixels; re-measure after replacing the source. The tail should point toward the mouth but stop before the face. Move a badly placed balloon before shortening its tail; for composite art you can point a short tail at an exact panel-relative target. Compare at page size and 100% before approving. Use a heavy Japanese gothic for shouts when appropriate; reserve drawn sound effects for sounds the reader cannot already infer from the artwork.
5. **Review the artwork and the page separately.** Compare the raw art and the page at reading size, then inspect the dense/dark details and tails at 100%. File story comments with the page and intended beat, art comments with the panel and continuity problem, and renderer reports with a minimal YAML reproduction, profile, CLI version, and expected/actual output. Separate actual rendering bugs from deliberate crop, placement, or source-art problems. Re-render the entire sequence after a panel change; a stronger isolated image can break a visual match across the page turn.
6. **Treat print as a second proof.** Inspect the processed linework and the effective-ppi diagnostics on the print profile. Regenerate missing detail or reduce the physical placement; a bigger output DPI or a simple resize is not new detail. Confirm the specific outlet's rules and the use of AI separately from the creative review. Keep unpublished pages and their sources in private review attachments unless the owner explicitly wants them published.

For a sequence in near darkness, compare the same crop, lettering, and layout with white margins and with `background: ink` on the individual pages. Use a thin `paper` panel border if the dark art merges into the gutters. Look at the transition back to white in the full sequence before choosing.

## Commands

Run from the repository root. For the sample tool, paths in the prompt spec are relative to that spec and the daemon shares the queue beneath `sample/gen/`.

```sh
node sample/tools/daemon.mjs
# In a different terminal:
node sample/tools/enqueue.mjs path/to/art/prompts.json p2-3 --n 2
npm run dev -- validate path/to/manga.yaml -p web --strict
npm run dev -- render path/to/manga.yaml -p web -o out/review
npm run dev -- render path/to/manga.yaml -p print-mono -o out/print
```
