/**
 * Theme Forge — turn any image into a full Hermes desktop theme.
 *
 * Drop/paste/browse an image; the palette engine extracts dominant colors
 * (median-cut), maps them to DesktopTheme tokens, guarantees WCAG contrast,
 * builds light + dark variants, and registers via THEMES_AREA — themes appear
 * live in Settings → Appearance, ⌘K, and /skin.
 *
 * Pane features: dark/light forge mode, drag-to-reorder swatch priorities
 * (re-synthesizes the theme live), inline rename, terminal ANSI preview,
 * Apply (jumps to Appearance settings), reforge, delete. Sources are kept
 * downscaled so themes can reforge after restarts.
 *
 * Save as: ~/.hermes/desktop-plugins/theme-forge/plugin.js
 * Plain ESM, loaded uncompiled — jsx() calls, not JSX syntax.
 */

import {
  Button,
  Input,
  PALETTE_AREA,
  ScrollArea,
  SegmentedControl,
  THEMES_AREA,
  cn,
  haptic,
  host,
  icons,
  useValue,
  atom
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

// ── reactive state (module-level, survives pane unmount) ────────────────────

const $busy = atom(false)
const $generated = atom([]) // persisted themes (full objects) — single source of truth
const $mode = atom('dark')
const $expanded = atom(null) // slug with terminal preview open
const $editing = atom(null) // slug being renamed

// ── color math ──────────────────────────────────────────────────────────────

const rgbToHex = (r, g, b) =>
  '#' +
  [r, g, b]
    .map(n =>
      Math.round(Math.min(255, Math.max(0, n)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')

const hexToRgb = hex => {
  const c = String(hex).trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(c)) return null
  return [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16))
}

const mix = (a, b, t) => {
  const A = hexToRgb(a)
  const B = hexToRgb(b)
  return A && B ? rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t) : a
}

const lin = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

const luminance = hex => {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map(v => lin(v / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a, b) => {
  const la = luminance(a)
  const lb = luminance(b)
  return la >= lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05)
}

const readableOn = bg => (luminance(bg) > 0.58 ? '#161616' : '#ffffff')

const ensureContrast = (color, bg, min) => {
  if (contrast(color, bg) >= min) return color
  const toward = luminance(bg) < 0.5 ? '#ffffff' : '#000000'
  let best = color
  for (let t = 0.1; t <= 1.001; t += 0.1) {
    const c = mix(color, toward, t)
    if (contrast(c, bg) > contrast(best, bg)) best = c
    if (contrast(c, bg) >= min) return c
  }
  return readableOn(bg)
}

function rgbToHsl(r, g, b) {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      default:
        h = ((r - g) / d + 4) / 6
    }
  }
  return { h, s, l }
}

// ── palette extraction: median-cut ──────────────────────────────────────────

function extractPalette(imgEl, maxColors = 12) {
  const w = imgEl.naturalWidth || imgEl.width
  const h = imgEl.naturalHeight || imgEl.height
  const side = 256
  const scale = Math.min(1, side / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale))
  const ch = Math.max(1, Math.round(h * scale))

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const g2d = canvas.getContext('2d', { willReadFrequently: true })
  g2d.drawImage(imgEl, 0, 0, cw, ch)

  const data = g2d.getImageData(0, 0, cw, ch).data
  const px = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    px.push([data[i], data[i + 1], data[i + 2]])
  }
  if (px.length < 8) throw new Error('Image has no usable pixels (too small or transparent)')

  let boxes = [px]
  while (boxes.length < maxColors) {
    let bi = 0
    let bestRange = -1
    let bestCh = 0
    boxes.forEach((box, idx) => {
      for (let ch2 = 0; ch2 < 3; ch2++) {
        let lo = 255
        let hi = 0
        for (const p of box) {
          if (p[ch2] < lo) lo = p[ch2]
          if (p[ch2] > hi) hi = p[ch2]
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo
          bestCh = ch2
          bi = idx
        }
      }
    })
    if (bestRange <= 0) break
    const box = boxes[bi]
    box.sort((a, b) => a[bestCh] - b[bestCh])
    const mid = Math.floor(box.length / 2)
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid))
  }

  return boxes
    .filter(b => b.length > 0)
    .map(b => {
      let r = 0
      let g = 0
      let bl = 0
      for (const p of b) {
        r += p[0]
        g += p[1]
        bl += p[2]
      }
      const n = b.length
      const hex = rgbToHex(r / n, g / n, bl / n)
      return { hex, hsl: rgbToHsl(r / n, g / n, bl / n), weight: n }
    })
    .sort((a, b) => b.weight - a.weight)
}

// ── theme synthesis ─────────────────────────────────────────────────────────
// Swatch ORDER is user-editable: index 0 seeds the background, remaining
// swatches rank as accent priority (most-chromatic slot first).

const slugify = s =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'forged'

function ansiPalette(ordered, bg) {
  const bgL = luminance(bg)
  const darkBg = bgL < 0.5
  // accent priority = swatches after the bg seed, chromatic ones first
  const chroma = ordered.slice(1).filter(c => c.hsl.s > 0.12)
  const fallbacks = ordered.slice(1).filter(c => c.hsl.s <= 0.12)
  const pool = [...chroma, ...fallbacks]

  const pick = (hLo, hHi, fi) => {
    const hit = chroma.find(c => {
      const h = c.hsl.h * 360
      return h >= hLo && h < hHi
    })
    const alt = pool.find((c, i) => i === fi % Math.max(1, pool.length))
    return (hit || alt || ordered[0]).hex
  }

  const tune = (hex, lift) =>
    darkBg ? ensureContrast(mix(hex, '#ffffff', lift), bg, 3) : ensureContrast(mix(hex, '#000000', lift * 0.8), bg, 3)

  const black = darkBg ? mix(bg, '#ffffff', 0.08) : mix(bg, '#000000', 0.55)
  const white = darkBg ? mix(bg, '#ffffff', 0.85) : mix(bg, '#000000', 0.08)

  return {
    foreground: readableOn(bg),
    cursor: tune(pick(150, 260, 0), 0.2),
    selectionBackground: darkBg ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)',
    black,
    red: tune(pick(345, 381, 0), 0.1),
    green: tune(pick(80, 160, 1), 0.1),
    yellow: tune(pick(40, 70, 2), 0.1),
    blue: tune(pick(200, 260, 3), 0.1),
    magenta: tune(pick(280, 345, 4), 0.1),
    cyan: tune(pick(160, 200, 5), 0.1),
    white,
    brightBlack: mix(black, white, darkBg ? 0.35 : 0.25),
    brightRed: mix(tune(pick(345, 381, 0), 0.1), white, darkBg ? 0.25 : 0),
    brightGreen: mix(tune(pick(80, 160, 1), 0.1), white, darkBg ? 0.25 : 0),
    brightYellow: mix(tune(pick(40, 70, 2), 0.1), white, darkBg ? 0.25 : 0),
    brightBlue: mix(tune(pick(200, 260, 3), 0.1), white, darkBg ? 0.25 : 0),
    brightMagenta: mix(tune(pick(280, 345, 4), 0.1), white, darkBg ? 0.25 : 0),
    brightCyan: mix(tune(pick(160, 200, 5), 0.1), white, darkBg ? 0.25 : 0),
    brightWhite: mix(white, darkBg ? '#ffffff' : '#000000', darkBg ? 0.4 : 0.18)
  }
}

function buildColorsFromPalette(ordered, wantDark) {
  const rest = ordered.slice(1)
  const byLum = [...ordered].sort((a, b) => a.hsl.l - b.hsl.l)
  const chromaRank = [...rest].sort((a, b) => b.hsl.s * (1 - Math.abs(b.hsl.l - 0.5)) - a.hsl.s * (1 - Math.abs(a.hsl.l - 0.5)))

  // accent = first chromatic swatch in USER order (priority), else chroma rank
  const userAccent = rest.find(c => c.hsl.s > 0.12)
  const accentRaw = userAccent || chromaRank[0] || ordered[0]

  let background
  let foreground
  if (wantDark) {
    background = byLum[0].hex
    if (luminance(background) > 0.09) background = mix(background, '#060608', 0.55)
    foreground = byLum[byLum.length - 1].hex
    if (luminance(foreground) < 0.55) foreground = mix(foreground, '#ffffff', 0.75)
  } else {
    background = byLum[byLum.length - 1].hex
    if (luminance(background) < 0.72) background = mix(background, '#ffffff', 0.7)
    foreground = byLum[0].hex
    if (luminance(foreground) > 0.35) foreground = mix(foreground, '#060608', 0.7)
  }

  const accentSafe = ensureContrast(accentRaw.hex, background, wantDark ? 3.2 : 3)
  const card = wantDark ? mix(background, '#ffffff', 0.045) : mix(background, '#000000', 0.015)
  const muted = wantDark ? mix(background, '#ffffff', 0.07) : mix(background, '#000000', 0.045)
  const mutedFg = ensureContrast(mix(foreground, background, 0.42), background, 4.5)
  const border = wantDark ? mix(background, '#ffffff', 0.14) : mix(background, '#000000', 0.13)

  return {
    background,
    foreground: ensureContrast(foreground, background, 7),
    card,
    cardForeground: ensureContrast(foreground, card, 7),
    muted,
    mutedForeground: mutedFg,
    popover: card,
    popoverForeground: ensureContrast(foreground, card, 7),
    primary: accentSafe,
    primaryForeground: readableOn(accentSafe),
    secondary: mix(muted, accentSafe, 0.12),
    secondaryForeground: ensureContrast(foreground, muted, 5),
    accent: mix(muted, accentSafe, 0.22),
    accentForeground: ensureContrast(foreground, mix(muted, accentSafe, 0.22), 5),
    border,
    input: border,
    ring: accentSafe,
    midground: accentSafe,
    composerRing: accentSafe,
    destructive: ensureContrast(wantDark ? '#c0473a' : '#c72e4d', background, 3),
    destructiveForeground: '#ffffff',
    sidebarBackground: wantDark ? mix(background, '#000000', 0.16) : mix(background, '#000000', 0.03),
    sidebarBorder: wantDark ? mix(border, '#ffffff', 0.02) : border,
    userBubble: mix(muted, accentSafe, 0.16),
    userBubbleBorder: mix(border, accentSafe, 0.3)
  }
}

/** Build the full DesktopTheme from an ORDERED swatch list. */
function synthesize(ordered, meta) {
  const darkColors = buildColorsFromPalette(ordered, true)
  const lightColors = buildColorsFromPalette(ordered, false)
  const primary = meta.mode === 'light' ? lightColors : darkColors
  return {
    name: meta.name,
    label: meta.label,
    description: 'Forged from an image · theme-forge plugin',
    colors: primary,
    darkColors,
    terminal: ansiPalette(ordered, primary.background),
    darkTerminal: ansiPalette(ordered, darkColors.background)
  }
}

/**
 * Recover a swatch list from a theme's own tokens — for v1-era entries that
 * never stored their extracted palette. Order follows the tray's semantics:
 * slot 1 = background seed, rest = accent priority.
 */
function deriveSwatches(theme) {
  const c = theme.darkColors || theme.colors || {}
  const t = theme.darkTerminal || theme.terminal || {}
  const candidates = [c.background, c.primary, c.foreground, t.red, t.green, t.blue, t.yellow, t.magenta, t.cyan, c.destructive, c.accent, c.secondary]
  const seen = new Set()
  const out = []
  for (const hex of candidates) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) continue
    const key = hex.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const rgb = hexToRgb(hex)
    if (!rgb) continue
    out.push({ hex, hsl: rgbToHsl(rgb[0], rgb[1], rgb[2]), weight: 1000 - out.length })
    if (out.length >= 8) break
  }
  return out
}

// ── persistence + registration ──────────────────────────────────────────────

let storageRef = null
let registerRef = null
const disposersBySlug = new Map()

function registerTheme(theme) {
  if (!registerRef) return
  if (disposersBySlug.has(theme.name)) disposersBySlug.get(theme.name)()
  // Fresh object identity each call → the registry snapshot cache busts and
  // the Appearance grid / active skin repaint live.
  const dispose = registerRef({ id: `theme:${theme.name}`, area: THEMES_AREA, data: { ...theme } })
  disposersBySlug.set(theme.name, dispose)
}

function saveThemes(list) {
  if (storageRef) storageRef.set('themes', list)
  $generated.set(list)
}

function updateTheme(slug, patch) {
  const list = storageRef ? storageRef.get('themes', []) : []
  const next = list.map(t => (t.name === slug ? { ...t, ...patch } : t))
  saveThemes(next)
  const t = next.find(x => x.name === slug)
  if (t && t.theme) registerTheme(t.theme)
  return t
}

// ── forge pipeline ──────────────────────────────────────────────────────────

async function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Could not decode that image'))
    el.src = url
  })
}

/** Downscale to a small JPEG data-URL so sources survive restarts cheaply. */
function thumbOf(imgEl) {
  const w = imgEl.naturalWidth || imgEl.width
  const h = imgEl.naturalHeight || imgEl.height
  const side = 128
  const s = Math.min(1, side / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * s))
  canvas.height = Math.max(1, Math.round(h * s))
  const g = canvas.getContext('2d')
  g.drawImage(imgEl, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.75)
}

async function forgeTheme(file, mode) {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImageFromUrl(url)
    const palette = extractPalette(img, 12)
    const baseName = file.name.replace(/\.[a-z0-9]+$/i, '')
    const slug = slugify(baseName)
    const label = baseName.length > 24 ? baseName.slice(0, 24) + '…' : baseName
    const ordered = [...palette].sort((a, b) => b.weight - a.weight).slice(0, 8)
    const themeName = `forge-${slug}`

    return {
      name: themeName,
      label: `Forge · ${label}`,
      mode,
      swatches: ordered,
      theme: synthesize(ordered, { name: themeName, label: `Forge · ${label}`, mode }),
      source: thumbOf(img),
      forgedAt: Date.now()
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    host.notify({ kind: 'warning', message: 'That file is not an image.' })
    return
  }
  $busy.set(true)
  forgeTheme(file, $mode.get())
    .then(entry => {
      const list = (storageRef ? storageRef.get('themes', []) : []).filter(t => t.name !== entry.name)
      list.unshift(entry)
      saveThemes(list)
      registerTheme(entry.theme)
      haptic('tap')
      host.notify({
        kind: 'success',
        message: `"${entry.label}" forged — Apply in the pane, or pick it in Settings → Appearance.`
      })
    })
    .catch(err => host.notifyError(err, 'Theme Forge'))
    .finally(() => $busy.set(false))
}

function reforge(entry) {
  if (!entry.source) {
    host.notify({ kind: 'warning', message: 'No source image kept for this theme — forge a new one.' })
    return
  }
  loadImageFromUrl(entry.source)
    .then(img => {
      const palette = extractPalette(img, 12)
      const ordered = [...palette].sort((a, b) => b.weight - a.weight).slice(0, 8)
      const theme = synthesize(ordered, entry)
      updateTheme(entry.name, { swatches: ordered, theme, mode: $mode.get() })
      haptic('tap')
      host.notify({ kind: 'success', message: `"${entry.label}" reforged.` })
    })
    .catch(err => host.notifyError(err, 'Theme Forge'))
}

// ── UI bits ─────────────────────────────────────────────────────────────────

/** Card thumbnail: the kept source image, or a color field built from the
 *  theme's own tokens for v1-era entries (no source persisted). */
function ThemeThumb({ entry }) {
  if (entry.source) {
    return jsx('img', { src: entry.source, alt: '', className: 'h-9 w-9 rounded-[3px] object-cover' })
  }
  const c = entry.theme?.darkColors || entry.theme?.colors || {}
  const t = entry.theme?.darkTerminal || entry.theme?.terminal || {}
  const bg = c.background || '#222222'
  const p1 = c.primary || '#888888'
  const p2 = t.cyan || t.green || p1
  return jsx('div', {
    className: 'h-9 w-9 rounded-[3px]',
    title: 'Theme colors (no source image kept)',
    style: {
      background: `linear-gradient(135deg, ${bg} 0%, ${bg} 40%, ${p1} 40%, ${p1} 70%, ${p2} 70%)`,
      boxShadow: 'inset 0 0 0 1px rgba(128,128,128,0.35)'
    }
  })
}

function TermPreview({ theme, mode }) {
  // Render a mini terminal using the theme's ANSI palette for the right mode
  const t = mode === 'light' && !theme.darkTerminal ? theme.terminal : mode === 'light' ? theme.terminal : theme.darkTerminal || theme.terminal
  const colors = mode === 'light' ? theme.colors : theme.darkColors || theme.colors
  const bg = colors.background
  const fg = t.foreground || colors.foreground

  const line = (chunks, key) =>
    jsx(
      'div',
      { className: 'whitespace-pre', children: chunks.map(([text, color], i) => jsx('span', { style: { color }, children: text }, `${key}-${i}`)) },
      key
    )

  return jsx('div', {
    className: 'rounded-[6px] p-2 font-mono text-[0.6875rem] leading-relaxed shadow-[inset_0_0_0_1px_rgba(128,128,128,0.25)]',
    style: { background: bg, color: fg },
    children: [
      line([['➜ ', t.green], ['~/farmfriend ', t.cyan], ['git status', fg]], 'l1'),
      line([['On branch ', fg], ['main', t.magenta]], 'l2'),
      line([['  modified:   ', t.yellow], ['src/agent/core.py', t.blue]], 'l3'),
      line([['  new file:   ', t.green], ['themes/', t.blue], ['forge.json', fg]], 'l4'),
      line([['$ ', t.green], ['hermes ', t.cyan], ['--profile ', t.yellow], ['closer', t.magenta], [' chat', fg]], 'l5'),
      line([['⚡ error: ', t.red], ['provider timeout — retrying', fg], [' (bright: ', t.brightYellow], ['ok', t.brightGreen], [')', fg]], 'l6')
    ]
  })
}

function SwatchTray({ entry }) {
  const dragIdx = useRef(null)
  const [over, setOver] = useState(null)

  // v1-era entries persisted with an empty swatch list — recover from tokens
  const swatches = entry.swatches && entry.swatches.length > 0 ? entry.swatches : deriveSwatches(entry.theme)

  const move = (from, to) => {
    if (from === to) return
    const sw = [...swatches]
    const [moved] = sw.splice(from, 1)
    sw.splice(to, 0, moved)
    const theme = synthesize(sw, entry)
    updateTheme(entry.name, { swatches: sw, theme })
    haptic('tap')
  }

  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsx('div', {
        className: 'text-[0.625rem] text-(--ui-text-quaternary)',
        children: 'drag swatches: 1st = background seed · order = accent priority'
      }),
      jsx('div', {
        className: 'flex flex-wrap gap-1',
        children: swatches.map((s, i) =>
          jsx(
            'div',
            {
              draggable: true,
              title: `#${i + 1} ${s.hex} — drag to reorder`,
              onDragStart: ev => {
                dragIdx.current = i
                ev.dataTransfer.effectAllowed = 'move'
              },
              onDragOver: ev => {
                ev.preventDefault()
                setOver(i)
              },
              onDragLeave: () => setOver(v => (v === i ? null : v)),
              onDrop: ev => {
                ev.preventDefault()
                setOver(null)
                if (dragIdx.current !== null) move(dragIdx.current, i)
                dragIdx.current = null
              },
              className: cn(
                'relative h-6 w-6 cursor-grab rounded-[4px] transition-transform active:cursor-grabbing',
                'shadow-[inset_0_0_0_1px_rgba(128,128,128,0.4)]',
                over === i && 'scale-110 shadow-[0_0_0_2px_var(--ui-accent)]'
              ),
              style: { background: s.hex },
              children: jsx('span', {
                className:
                  'absolute -top-1 -right-1 flex h-3 w-3 items-center justify-center rounded-full text-[0.5rem] font-bold',
                style: { background: s.hex, color: readableOn(s.hex), boxShadow: 'inset 0 0 0 1px rgba(128,128,128,0.5)' },
                children: i + 1
              })
            },
            `sw-${i}`
          )
        )
      })
    ]
  })
}

function ThemeCard({ entry }) {
  const expanded = useValue($expanded) === entry.name
  const editing = useValue($editing) === entry.name
  const mode = useValue($mode)
  const [draft, setDraft] = useState(entry.label)

  useEffect(() => {
    if (editing) setDraft(entry.label.replace(/^Forge · /, ''))
  }, [editing])

  const commitRename = () => {
    const clean = draft.trim()
    if (clean) {
      const label = `Forge · ${clean}`
      const theme = { ...entry.theme, label }
      updateTheme(entry.name, { label, theme })
      host.notify({ kind: 'success', message: `Renamed to "${label}".` })
    }
    $editing.set(null)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-1.5 rounded-[6px] p-2 shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)]',
    children: [
      // header row
      jsxs('div', {
        className: 'flex items-center gap-1.5',
        children: [
          jsx(ThemeThumb, { entry }),
          editing
            ? jsxs('div', { className: 'flex min-w-0 flex-1 items-center gap-1', children: [
                jsx(Input, {
                  autoFocus: true,
                  value: draft,
                  onChange: ev => setDraft(ev.target.value),
                  onKeyDown: ev => {
                    if (ev.key === 'Enter') commitRename()
                    if (ev.key === 'Escape') $editing.set(null)
                  },
                  className: 'h-6 min-w-0 flex-1 text-xs'
                }),
                jsx(Button, { variant: 'ghost', size: 'icon-xs', onClick: commitRename, children: jsx(icons.Check, {}) })
              ] })
            : jsx('button', {
                type: 'button',
                title: 'Rename',
                onClick: () => $editing.set(entry.name),
                className: 'min-w-0 flex-1 truncate text-left text-xs font-medium text-(--ui-text-primary) hover:underline',
                children: entry.label
              }),
          jsx(Button, {
            variant: 'ghost',
            size: 'icon-xs',
            title: 'Rename theme',
            onClick: () => $editing.set(entry.name),
            children: jsx(icons.Pencil, {})
          }),
          jsx(Button, {
            variant: 'ghost',
            size: 'icon-xs',
            title: expanded ? 'Hide terminal preview' : 'Terminal preview',
            onClick: () => $expanded.set(expanded ? null : entry.name),
            children: jsx(icons.Terminal, {})
          }),
          jsx(Button, {
            variant: 'ghost',
            size: 'icon-xs',
            title: 'Reforge from source image',
            onClick: () => reforge(entry),
            children: jsx(icons.RefreshCw, {})
          }),
          jsx(Button, {
            variant: 'ghost',
            size: 'icon-xs',
            title: 'Delete theme',
            onClick: () => {
              const list = (storageRef ? storageRef.get('themes', []) : []).filter(t => t.name !== entry.name)
              saveThemes(list)
              const d = disposersBySlug.get(entry.name)
              if (d) {
                d()
                disposersBySlug.delete(entry.name)
              }
              haptic('tap')
              host.notify({ kind: 'info', message: `Removed "${entry.label}".` })
            },
            children: jsx(icons.Trash2, {})
          })
        ]
      }),

      jsx(SwatchTray, { entry }),

      jsx(Button, {
        variant: 'secondary',
        size: 'xs',
        onClick: () => {
          host.navigate('/settings?tab=config:appearance')
          host.notify({ kind: 'info', message: `Click "${entry.label}" in the grid to apply.` })
        },
        children: 'Apply…'
      }),

      expanded ? jsx(TermPreview, { theme: entry.theme, mode: entry.mode || mode }) : null
    ]
  })
}

function ForgePane() {
  const busy = useValue($busy)
  const generated = useValue($generated)
  const mode = useValue($mode)

  const onDrop = ev => {
    ev.preventDefault()
    handleFile(ev.dataTransfer?.files?.[0])
  }

  return jsxs('div', {
    'data-forge-pane': 'true',
    tabIndex: 0,
    className: 'flex h-full flex-col gap-3 overflow-hidden p-3 text-sm outline-none',
    onDragOver: ev => ev.preventDefault(),
    onDrop,
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between',
        children: [
          jsx('div', { className: 'font-medium text-(--ui-text-primary)', children: 'Theme Forge' }),
          jsx('div', {
            className: 'w-[130px]',
            children: jsx(SegmentedControl, {
              options: [
                { id: 'dark', label: 'Dark' },
                { id: 'light', label: 'Light' }
              ],
              value: mode,
              onChange: v => $mode.set(v)
            })
          })
        ]
      }),

      jsxs('label', {
        className: cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[6px] border border-dashed p-4 text-center transition-colors',
          'border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)'
        ),
        children: [
          jsx(icons.Upload, { className: 'size-4 text-(--ui-text-tertiary)' }),
          jsx('div', { className: 'text-xs text-(--ui-text-secondary)', children: busy ? 'Forging…' : 'Drop an image here' }),
          jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'or click to browse · click pane then ⌘V to paste' }),
          jsx('input', { type: 'file', accept: 'image/*', className: 'hidden', onChange: ev => handleFile(ev.target.files?.[0]) })
        ]
      }),

      jsxs('div', {
        className: 'flex min-h-0 flex-1 flex-col gap-1.5',
        children: [
          jsx('div', {
            className: 'text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
            children: `Forged themes (${generated.length})`
          }),
          jsx(ScrollArea, {
            className: 'min-h-0 flex-1',
            children: jsx('div', {
              className: 'flex flex-col gap-2 pb-2',
              children: generated.length
                ? generated.map(entry => jsx(ThemeCard, { entry }, entry.name))
                : jsx('div', { className: 'py-2 text-xs text-(--ui-text-tertiary)', children: 'None yet — forge one above.' })
            })
          })
        ]
      })
    ]
  })
}

// ── plugin entry ────────────────────────────────────────────────────────────

let pasteHandler = null

export default {
  id: 'theme-forge',
  name: 'Theme Forge',

  register(ctx) {
    storageRef = ctx.storage
    registerRef = ctx.register

    // One-time schema migration: v1 stored raw theme objects; v2 stores
    // { name, label, mode, swatches, theme, source } entries.
    const migrated = ctx.storage.get('themes', []).map(e =>
      e && !e.theme && e.colors
        ? { name: e.name, label: e.label, mode: 'dark', swatches: [], theme: e, source: null, forgedAt: Date.now() }
        : e
    )
    ctx.storage.set('themes', migrated)

    // Re-register every persisted theme so they survive restarts.
    for (const entry of migrated) {
      if (entry?.theme?.name && entry.theme.colors) registerTheme(entry.theme)
    }
    $generated.set(migrated)

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'theme forge',
      data: { placement: 'right', width: '270px' },
      render: () => jsx(ForgePane, {})
    })

    ctx.register({
      id: 'palette-open',
      area: PALETTE_AREA,
      data: {
        id: 'theme-forge-open',
        label: 'Theme Forge: forge a theme from an image',
        keywords: ['theme', 'skin', 'color', 'palette', 'image'],
        run: () =>
          host.notify({ kind: 'info', message: 'Drop or paste an image into the Theme Forge pane (right side).' })
      }
    })

    // Capture-phase paste: forge image pastes aimed at the pane or plain
    // chrome; never steal pastes aimed at the chat composer.
    pasteHandler = ev => {
      const item = Array.from(ev.clipboardData?.items || []).find(i => i.type.startsWith('image/'))
      if (!item) return
      const t = ev.target
      const inPane = t instanceof Element && !!t.closest('[data-forge-pane]')
      const editable = t instanceof Element && !!t.closest('input, textarea, [contenteditable="true"]')
      if (!inPane && editable) return
      const file = item.getAsFile()
      if (file) {
        ev.preventDefault()
        ev.stopPropagation()
        handleFile(file)
      }
    }
    window.addEventListener('paste', pasteHandler, true)

    ctx.onDispose(() => {
      if (pasteHandler) window.removeEventListener('paste', pasteHandler, true)
      pasteHandler = null
      disposersBySlug.forEach(d => d())
      disposersBySlug.clear()
    })
  }
}
