// Validate Theme Forge's theme math in isolation (same functions as plugin.js).
// Feeds it synthetic pixels matching /tmp/forge-test.png's color blocks and
// asserts the generated DesktopTheme is structurally valid.

const fs = require('fs')
const src = fs.readFileSync(process.env.HOME + '/.hermes/desktop-plugins/theme-forge/plugin.js', 'utf8')

// Pull out everything between the color-math header and the UI section,
// minus the canvas-dependent extractPalette (tested separately with fake boxes).
const start = src.indexOf('// ── color math')
const end = src.indexOf('// ── forge pipeline')
let core = src.slice(start, end)

// eval in this scope — wrap so const bindings come back out
const api = new Function(core + '; return {rgbToHex, rgbToHsl, buildColorsFromPalette, ansiPalette, synthesize, deriveSwatches, contrast, luminance, mix, readableOn, ensureContrast}')()
const { rgbToHex, rgbToHsl, buildColorsFromPalette, ansiPalette, synthesize, deriveSwatches, contrast, luminance, mix, readableOn, ensureContrast } = api

// Simulate palette output of extractPalette for our test image blocks
const mk = (r, g, b, w) => ({ hex: rgbToHex(r, g, b), hsl: rgbToHsl(r, g, b), weight: w })
const palette = [
  mk(13, 47, 134, 2000), mk(255, 120, 50, 1800), mk(255, 224, 196, 1500),
  mk(120, 30, 80, 1400), mk(46, 160, 120, 1300), mk(240, 200, 60, 1200),
  mk(110, 60, 110, 600)  // gradient average
]

const REQUIRED = ['background', 'foreground', 'primary']
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

for (const wantDark of [true, false]) {
  const c = buildColorsFromPalette(palette, wantDark)
  const label = wantDark ? 'dark' : 'light'
  check(`[${label}] required keys`, REQUIRED.every(k => typeof c[k] === 'string' && /^#[0-9a-f]{6}$/i.test(c[k])))
  check(`[${label}] all 23 tokens are hex`, Object.entries(c).every(([k, v]) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v), Object.keys(c).length + ' tokens'))
  check(`[${label}] fg contrast ≥ 7 on bg`, contrast(c.foreground, c.background) >= 7, contrast(c.foreground, c.background).toFixed(2))
  check(`[${label}] mutedFg contrast ≥ 4.5`, contrast(c.mutedForeground, c.background) >= 4.5, contrast(c.mutedForeground, c.background).toFixed(2))
  check(`[${label}] primary visible on bg`, contrast(c.primary, c.background) >= 3, contrast(c.primary, c.background).toFixed(2))
  check(`[${label}] bg luminance sane`, wantDark ? luminance(c.background) < 0.15 : luminance(c.background) > 0.6, luminance(c.background).toFixed(3))

  const t = ansiPalette(palette, c.background)
  const ansiKeys = ['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite']
  check(`[${label}] terminal: 16 ANSI slots`, ansiKeys.every(k => /^#[0-9a-f]{6}$/i.test(t[k])))
  check(`[${label}] terminal fg/cursor set`, typeof t.foreground === 'string' && typeof t.cursor === 'string')
  // black (dark bg) and white (light bg) are intentionally near-background —
  // standard terminal behavior — so exclude them from the visibility floor.
  const visKeys = ansiKeys.filter(k => !(wantDark && k === 'black') && !(!wantDark && k === 'white'))
  check(`[${label}] ANSI colors visible on term bg`, visKeys.every(k => contrast(t[k], c.background) >= 1.4), 'min ' + Math.min(...visKeys.map(k => contrast(t[k], c.background))).toFixed(2))
}

// Full theme shape check via synthesize (what THEMES_AREA receives)
const meta = { name: 'forge-test', label: 'Forge · test', mode: 'dark' }
const theme = synthesize(palette, meta)
check('theme: isValidTheme bar (name/label/colors + required)', !!theme.name && !!theme.label && REQUIRED.every(k => typeof theme.colors[k] === 'string'))
check('theme: label carries through', theme.label === 'Forge · test')
// Reorder check: moving a saturated color to front shouldn't crash synthesis
const reordered = [palette[1], ...palette.slice(0, 1), ...palette.slice(2)]
const t2 = synthesize(reordered, meta)
check('theme: reorder-safe synthesis', REQUIRED.every(k => typeof t2.colors[k] === 'string') && typeof t2.terminal.red === 'string')

// deriveSwatches: v1-era themes (no stored palette) must recover a usable tray
const derived = deriveSwatches(theme)
check('deriveSwatches: 4-8 swatches from tokens', derived.length >= 4 && derived.length <= 8, derived.length + ' swatches')
check('deriveSwatches: valid hex + hsl', derived.every(s => /^#[0-9a-f]{6}$/i.test(s.hex) && typeof s.hsl.h === 'number'))
const t3 = synthesize(derived, meta)
check('deriveSwatches: resynthesis round-trip', REQUIRED.every(k => typeof t3.colors[k] === 'string') && typeof t3.terminal.green === 'string')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURES`)
process.exit(failures ? 1 : 0)
