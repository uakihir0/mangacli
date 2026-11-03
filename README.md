English | [日本語](README.ja.md)

# mangacli

mangacli renders Japanese-style manga pages from a structured description. You write the page layout, panels, speech balloons, dialogue, and effects in YAML (or build the same structure as a TypeScript object), and mangacli outputs finished page images in black-and-white or color.

You supply the artwork (characters, backgrounds) as image files. mangacli draws everything else: panel borders, speech balloons, typeset dialogue, hand-lettered sound effects, focus lines and other effect lines, screentones, and manpu marks. All of it is drawn to look **hand-inked**: balloons wobble slightly, lines taper and vary with pen pressure, and closed outlines don't meet perfectly.

> **Status:** specification phase. Nothing is implemented yet. The full specification is in [docs/](docs/README.md) (written in Japanese).

## Planned features

- Japanese manga conventions by default: right-to-left reading, vertical text, mixed antique/gothic fonts (アンチゴチ), ruby, tate-chu-yoko, line-breaking rules, gutters, bleed panels, page numbers, and crop marks.
- Balloons in many styles: ellipse, thought cloud, shout spikes, trembling, whisper (dashed), narration box, electronic voice, and more. Tails aim at a character automatically.
- Effects: focus lines, beta flash, uni flash, speed lines, gloom lines, cross-hatching, and screentones (dot, line, noise, and gradient tones).
- Output as PNG, JPEG, or WebP (PDF, SVG, and TIFF planned for v1.0). Color, grayscale, or 1-bit monochrome for print, including bleed.
- Deterministic: the same input always produces the same output. Change the seed to get a "redrawn" take.
- Japanese fonts are fetched on demand from a built-in catalog of SIL OFL fonts, so pages render without any font setup.
- Both a CLI and a TypeScript API.

## A taste of the format

```yaml
mangacli: 1

assets:
  taro: ./assets/taro.png

pages:
  - layout:
      rows: [[1], [1, 1]]
    panels:
      - layers:
          - image: taro
          - balloon: おはよう
      - layers:
          - balloon: |
              今日は
              いい天気だね
      - layers:
          - effect: focus-lines
          - text: その時——
            place: top-right
```

```bash
npx mangacli render manga.yaml --profile print-mono
```

## License

MIT
