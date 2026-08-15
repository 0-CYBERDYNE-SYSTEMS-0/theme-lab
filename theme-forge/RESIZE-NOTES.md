# Theme Forge — resize behavior notes

How the pane adapts when resized, and the intentional constraints.

## The hard constraint: frozen build CSS

The desktop app ships a Tailwind stylesheet compiled ONLY from the app's own
source tree at build time. Plugins load at runtime from `~/.hermes`, so any
class used ONLY by a plugin generates NO CSS rules. Before touching layout
here, verify every class against the shipped stylesheet:

    app.asar.unpacked/dist/assets/index-*.css   (inside the release build)

Rules this pane follows:
- No `sm:` / breakpoint variants (the build contains zero `@media (min-width)`).
- No arbitrary values used only here (`shadow-[…]`, `w-[min(…)]`, `accent-(…)`,
  `scale-*`, `flex-nowrap`…). Those live as inline `style` instead.
- Anything size-critical (the color wheel) is sized inline in px.

## What resizes fluidly

- Pane zone: `width: 280px` default, `minWidth: 220px`, `maxWidth: 520px`
  (CSS STRINGS — the PaneSizing contract rejects bare numbers). The v2 panel
  docks explicitly at `workspace → right`, which gives Forge its own split zone
  and sash rather than joining the generic right-side tab group.
- Card header row: `flex-wrap`, so at narrow widths the icon-button cluster
  wraps to a second line instead of clipping the name.
- Theme name: `min-w-0 truncate` — long names ellipsize, never push buttons out.
- Swatch tray + strip palette: responsive wrapping grids. They keep 36px card
  swatches tappable and add rows instead of producing a sideways control rail.
- Theme list: `ScrollArea` with `min-h-0 flex-1` — vertical scroll, never clips.
- Terminal preview: `overflow-x-auto` — the single intentional horizontal
  scroll surface, preserving long monospace lines without clipping.
- Drop zone / header / segmented controls: `min-w-0`, wrap when needed.

## Intentional non-fluid cases (graceful degradation)

1. **Color wheel = fixed 128px square.** A fluid wheel needs ResizeObserver
   plumbing for pointer math (radius from live rect); not worth the complexity
   for a 220–520px pane. Instead the wheel+controls container is `flex-wrap`:
   below ~260px content width the controls column wraps UNDER the wheel.
2. **Swatch slots = fixed 36px.** They wrap into additional rows instead of
   shrinking or scrolling sideways. Shrinking below ~28px makes them untappable.
3. **Segmented controls** keep their natural width; at extreme narrow widths
   the header row wraps rather than compressing the controls.

## Pointer interaction note

The color wheel's hue/sat picking uses `setPointerCapture` on the wheel div —
handlers (`onPointerDown/Move/Up/Cancel`) MUST stay attached to that same div.
A refactor that lifts them off silently kills the drag (this happened once;
regression-fixed in commit 5404738).

## Palette retention and role mapping

- Image extraction uses median-cut with a maximum of **12** color boxes.
- New and reforged entries retain all extracted boxes through persistence and
  render all retained slots in the wrapping tray/strip.
- Slot roles are explicit: background; text/primary; secondary; accent;
  destructive; border; input/sidebar; bubble; then ANSI red/green/blue/magenta.
- Slots 9–12 also seed visible destructive/accent/sidebar/bubble surfaces so the
  palette remains meaningful when a backend skin bridge does not carry ANSI
  fields through to the host.
- Placed chromatic background/text colors remain verbatim. Only neutral,
  genuinely unreadable text seeds enter the narrow contrast tripwire.

## Ingest and preview safety

- New image identities use `forge-<slug>-<base36 timestamp>-<short suffix>`;
  filenames are labels, not primary keys, so repeated filenames create new
  entries instead of replacing prior themes.
- A second image cannot start while one is forging; this prevents concurrent
  same-identity completion races. Reforge remains the explicit in-place update
  action for an existing theme.
- New entries retain a compact 128px source thumbnail for reforge and a separate
  512px JPEG preview for the thumbnail-click dialog. Legacy entries fall back to
  their existing source thumbnail.
- Card and strip thumbnails are independent preview buttons; Apply remains a
  separate action in Strip mode. Preview closes by backdrop, Escape, or Close.