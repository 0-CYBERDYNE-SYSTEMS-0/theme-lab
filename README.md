# Theme Lab ⚒️

**Turn any image into a full Hermes desktop theme.** A desktop plugin for
[Hermes Agent](https://github.com/NousResearch/hermes-agent) — paste a screenshot,
a photo, anything, and get a color-matched light + dark theme with a complete
16-color terminal palette, installed live into the app.

> Plugin id: `theme-forge` (that's the folder name and the slug the app uses).

## What you get

- **Image → theme in one drop.** Paste, drag-and-drop, or browse for an image.
  Median-cut palette extraction finds the dominant colors and maps them to
  every `DesktopTheme` token.
- **Your swatch, verbatim.** Slot 1 seeds the background, slot 2 seeds the
  text color (UI + terminal), and the first chromatic swatch seeds the accent —
  the exact color you place is the exact color that lands in the theme. No
  contrast re-mixing, no blending: what you swap is what you get. (Secondary
  tokens like muted text still get contrast-safe derivation.)
- **Light + dark variants** per forge, plus a full 16-slot ANSI terminal palette
  (with correct near-background black/white behavior per background tone).
- **Live everywhere.** Themes register via `THEMES_AREA` — they appear instantly
  in Settings → Appearance, ⌘K search, and `/skin`.
- **Editing, not just generation.** Drag swatches to reorder priority (re-synthesizes
  live), open the full color picker on any swatch — HSV wheel, H/S/L sliders,
  editable hex field, preset color cells, and a screen eyedropper — rename,
  reforge from the kept source image, delete. A quiet strip view shows swatches only.
- **Survives restarts.** Themes persist in plugin storage with schema migration —
  v1 themes are auto-recovered (swatches rebuilt from tokens, thumbnails derived).
- **Zero dependencies.** One plain-ESM file loaded uncompiled by the app. No build
  step, no node_modules, no API keys.

## Install

Requires the **Hermes desktop app** (`hermes desktop`) on macOS, Windows, or Linux.

```bash
git clone https://github.com/0-CYBERDYNE-SYSTEMS-0/theme-lab.git
cp -r theme-lab/theme-forge ~/.hermes/desktop-plugins/
```

The app watches `desktop-plugins/` and hot-loads within seconds. If it doesn't
appear: ⌘K → **Reload desktop plugins**. Then open the **Theme Forge** pane and
drop an image on it.

To uninstall: delete `~/.hermes/desktop-plugins/theme-forge/`.

## Usage

1. Open the **Theme Forge** pane (drag it wherever you like).
2. Drop / paste / browse for an image.
3. Pick **dark** or **light** forge mode, reorder swatches if you want a color to
   dominate, then hit **Apply** — it jumps you to the Appearance grid where the
   new theme card is waiting.

## Development

The color math is validated by a standalone Node harness:

```bash
node theme-forge/forge-math-test.cjs   # 74 checks — palette math, verbatim swatch→theme contract, ANSI mapping, picker wiring, migration
```

Run it after touching anything in the `── color math ──` section of `plugin.js`.
`RESIZE-NOTES.md` documents the frozen-CSS layout constraints of the packaged app.

## Notes for plugin authors

Desktop plugins are single ESM files importing only `@hermes/plugin-sdk`, `react`,
and `react/jsx-runtime` — UI is `jsx()` calls, not JSX syntax. The official docs:
[Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk).

## License

MIT — see [LICENSE](LICENSE).
