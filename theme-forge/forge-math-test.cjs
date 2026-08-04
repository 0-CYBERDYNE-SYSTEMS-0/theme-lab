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
const api = new Function(core + '; return {rgbToHex, hexToRgb, rgbToHsl, hslToRgb, hexToHsl, hslToHex, buildColorsFromPalette, ansiPalette, synthesize, deriveSwatches, contrast, luminance, mix, readableOn, ensureContrast}')()
const { rgbToHex, hexToRgb, rgbToHsl, hslToRgb, hexToHsl, hslToHex, buildColorsFromPalette, ansiPalette, synthesize, deriveSwatches, contrast, luminance, mix, readableOn, ensureContrast } = api

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

// ── Wheel HSL↔HEX round-trip ────────────────────────────────────────────
const wheelColors = [mk(13, 47, 134, 5000), mk(255, 120, 50, 4000), mk(46, 160, 120, 3000), mk(240, 235, 220, 2000)]
const wheelOk = wheelColors.every(c => {
  const back = hslToHex(c.hsl.h, c.hsl.s, c.hsl.l)
  const hsl = hexToHsl(back)
  return typeof back === 'string' && /^#[0-9a-f]{6}$/i.test(back) && hsl && Math.abs(hsl.h - c.hsl.h) < 0.005 && Math.abs(hsl.s - c.hsl.s) < 0.005 && Math.abs(hsl.l - c.hsl.l) < 0.005
})
check('wheel: hsl↔hex round-trip', wheelOk, `${wheelColors.length} sample swatches`)

// ── Slot-1 background control
const hueDist = (a, b) => {
  const d = Math.abs(a * 360 - b * 360) % 360
  return d > 180 ? 360 - d : d
}
// Build an order where slot 1 is NOT the darkest color — old code would have
// ignored slot 1 and used the darkest anyway.
const teal = mk(46, 160, 120, 5000)   // mid-tone teal, deliberately not darkest
const deepBlue = mk(13, 47, 134, 4000)
const ordered2 = [teal, deepBlue, mk(255, 120, 50, 3000), mk(255, 224, 196, 2000), mk(120, 30, 80, 1000)]
const themeA = synthesize(ordered2, { name: 'x', label: 'x', mode: 'dark' })
const bgA = themeA.darkColors.background
const bgAHue = rgbToHsl(...hexToRgb(bgA)).h
check('slot1-ctrl: dark bg hue follows teal seed', hueDist(bgAHue, teal.hsl.h) < 35, `bg ${bgA} hueDist=${hueDist(bgAHue, teal.hsl.h).toFixed(1)}°`)
check('slot1-ctrl: dark bg stays dark w/ mid-tone seed', luminance(bgA) < 0.15, luminance(bgA).toFixed(3))

// Swap: put deep blue in slot 1 — bg hue must follow
const ordered3 = [deepBlue, teal, mk(255, 120, 50, 3000), mk(255, 224, 196, 2000), mk(120, 30, 80, 1000)]
const themeB = synthesize(ordered3, { name: 'x', label: 'x', mode: 'dark' })
const bgB = themeB.darkColors.background
const bgBHue = rgbToHsl(...hexToRgb(bgB)).h
check('slot1-ctrl: swap changes bg hue', hueDist(bgBHue, deepBlue.hsl.h) < 35 && hueDist(bgAHue, bgBHue) > 20, `bgA=${bgA} bgB=${bgB} Δ=${hueDist(bgAHue, bgBHue).toFixed(1)}°`)

// Light mode: dark seed in slot 1 must still yield a light background
const themeC = synthesize([deepBlue, teal, mk(255, 224, 196, 2000)], { name: 'x', label: 'x', mode: 'light' })
const bgC = themeC.colors.background
check('slot1-ctrl: light bg stays light w/ dark seed', luminance(bgC) > 0.6, luminance(bgC).toFixed(3))
check('slot1-ctrl: light bg keeps seed hue', hueDist(rgbToHsl(...hexToRgb(bgC)).h, deepBlue.hsl.h) < 40, `bg ${bgC}`)

// Very bright seed in dark mode: must still land dark
const themeD = synthesize([mk(255, 224, 196, 5000), teal, deepBlue], { name: 'x', label: 'x', mode: 'dark' })
const bgD = themeD.darkColors.background
check('slot1-ctrl: dark bg from bright seed still dark', luminance(bgD) < 0.2, luminance(bgD).toFixed(3))

// ── Slot-2 foreground control (regression: was always luminance-extreme derived) ──
// Use distinct swatches so hue swaps are observable.
const softPink = mk(230, 150, 160, 1200)
const skyBlue = mk(120, 180, 255, 1100)
const slot2Base = [teal, softPink, skyBlue, mk(255, 120, 50, 3000), mk(120, 30, 80, 2000)]
const themeFG1 = synthesize(slot2Base, { name: 'x', label: 'x', mode: 'dark' })
const themeFG2 = synthesize([...slot2Base.slice(0, 1), skyBlue, softPink, ...slot2Base.slice(3)], { name: 'x', label: 'x', mode: 'dark' })
check('slot2-ctrl: swapping slot 2 changes dark fg hue', hueDist(rgbToHsl(...hexToRgb(themeFG1.darkColors.foreground)).h, rgbToHsl(...hexToRgb(themeFG2.darkColors.foreground)).h) > 15, `fg1=${themeFG1.darkColors.foreground} fg2=${themeFG2.darkColors.foreground}`)
check('slot2-ctrl: light swap changes light fg hue', hueDist(rgbToHsl(...hexToRgb(themeFG1.colors.foreground)).h, rgbToHsl(...hexToRgb(themeFG2.colors.foreground)).h) > 15, `fg1=${themeFG1.colors.foreground} fg2=${themeFG2.colors.foreground}`)
check('slot2-ctrl: dark fg contrast >= 7 on bg', contrast(themeFG1.darkColors.foreground, themeFG1.darkColors.background) >= 7, contrast(themeFG1.darkColors.foreground, themeFG1.darkColors.background).toFixed(2))
check('slot2-ctrl: light fg contrast >= 7 on bg', contrast(themeFG1.colors.foreground, themeFG1.colors.background) >= 7, contrast(themeFG1.colors.foreground, themeFG1.colors.background).toFixed(2))

// Light seed in dark-mode slot 2: foreground should follow that hue/character,
// but must stay usable — no collapse to pure white.
const lightSeedFG = mk(240, 235, 220, 4000)
const themeLightSeed = synthesize([deepBlue, lightSeedFG, skyBlue], { name: 'x', label: 'x', mode: 'dark' })
const lightSeedFGResult = themeLightSeed.darkColors.foreground
check('slot2-ctrl: light seed fg does not collapse to white', lightSeedFGResult.toLowerCase() !== '#ffffff', lightSeedFGResult)
check('slot2-ctrl: light seed fg still passes contrast', contrast(lightSeedFGResult, themeLightSeed.darkColors.background) >= 7, contrast(lightSeedFGResult, themeLightSeed.darkColors.background).toFixed(2))

// Single-swatch fallback preserves prior behavior when slot 2 is absent.
const themeSingle = synthesize([softPink], { name: 'x', label: 'x', mode: 'dark' })
check('slot2-ctrl: single swatch still derives fg', typeof themeSingle.darkColors.foreground === 'string' && contrast(themeSingle.darkColors.foreground, themeSingle.darkColors.background) >= 7, themeSingle.darkColors.foreground)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURES`)
process.exit(failures ? 1 : 0)

// ── Plugin behavior probes ────────────────────────────────────────────────
const pluginPath = process.env.HOME + '/.hermes/desktop-plugins/theme-forge/plugin.js'
const pluginSrc = fs.readFileSync(pluginPath, 'utf8')

// viewMode persistence defaults to cards and round-trips through storage.
const viewModeMatch = pluginSrc.match(/const \$viewModeKey = '([^']+)'/)
const viewModeKey = viewModeMatch ? viewModeMatch[1] : null
check('storage: viewMode key is declared', !!viewModeKey, viewModeKey || 'missing')

const storageRoundTripOk = pluginSrc.includes(`$viewModeKey`) &&
  pluginSrc.includes(`ctx.storage.get($viewModeKey, 'cards')`) &&
  pluginSrc.includes(`storageRef?.set($viewModeKey, normalizeViewMode(v))`) &&
  pluginSrc.includes(`storageRef?.set($viewModeKey, 'cards')`)
check('storage: viewMode default + persisted round-trip wired', storageRoundTripOk)

const stripRowExists = /function StripRow\(/.test(pluginSrc)
check('ui: StripRow component exists', stripRowExists)
const stripEntrypoint = pluginSrc.includes('StripRow')
check('ui: strip mode renders StripRow', stripEntrypoint)
