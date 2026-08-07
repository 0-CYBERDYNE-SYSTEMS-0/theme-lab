/**
 * Buzz-Hive — a Buzz-like agent room inside the Hermes desktop app.
 *
 * Up to 10 Hermes agent profiles share one room with the user + the default
 * agent. The user @-tags any member; members coordinate with each other over a
 * tag grammar relayed by this plugin. One member holds the browser role.
 *
 * Model (all grounded in ~/.hermes/hermes-agent source, Aug 2026):
 *  - Concurrent per-profile sockets  → gateway.ts:9-16 (events tagged `profile`)
 *  - profile list                    → /api/profiles via window.hermesDesktop.api
 *  - mint a member session           → host.request('session.create', {profile,...})
 *  - inject into any session         → host.request('prompt.submit',{session_id,text})
 *  - hear a member's finished turn   → host.onEvent('assistant.completed', e) e.content
 *
 * Save as: ~/.hermes/desktop-plugins/buzz-hive/plugin.js
 * Plain ESM, loaded uncompiled — jsx() calls, not JSX syntax.
 */

import {
  atom,
  useValue,
  host,
  Button,
  Input,
  Textarea,
  ScrollArea,
  Badge,
  StatusDot,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  icons,
  cn,
  profileColor,
  haptic
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState } from 'react'

// ── config ──────────────────────────────────────────────────────────────────
const PLUGIN_ID = 'buzz-hive'
const MAX_MEMBERS = 10 // profile members (You is extra, pinned)
const DIGEST_LEN = 12
const STORAGE_KEY = 'hive.v1'

// ── reactive state ──────────────────────────────────────────────────────────
const $members = atom([]) // { profile, sessionId, storedId, status, browser }
const $timeline = atom([]) // { id, ts, from, kind:'user'|'agent'|'relay'|'system', text, to? }
const $title = atom('hive')
const $cwd = atom('')
const $expanded = atom(null) // profile id with the "fresh context / remove" menu open
const $composer = atom('')
const $mentionOpen = atom('') // autocomplete filter when composing @name

// module refs set in register()
let storageRef = null

// ── create-CORE-BEGIN (pure functions; sliced verbatim by test.cjs) ────────

const _normalize = (name) => ((name || '').trim() || 'default').toLowerCase()

/**
 * Parse a member's finished output (or a user post) into coordination actions.
 * Machine grammar (agents are taught it in the room brief):
 *   [to @name] text   → private relay to that member
 *   [ask @name] text  → relay + flagged as a question
 *   [all] text        → broadcast (timeline + digest)
 *   [@name] text      → private relay to that member
 * Brackets in normal prose are rare; this is a structured protocol.
 * Returns { relays:[{target,text,ask}], broadcast:string }.
 */
function parseCoordination(content, roster) {
  const result = { relays: [], broadcast: '' }
  const text = (content || '').trim()
  if (!text) return { relays: [], broadcast: text }
  const rosterSet = new Set((roster || []).map(_normalize))
  const TOKEN =
    /\[(?:to\s+@?([a-z0-9._-]+)|ask\s+@?([a-z0-9._-]+)|@([a-z0-9._-]+)|all)([^\]]*?)\]/gi
  const bcast = []
  let last = 0
  let m
  TOKEN.lastIndex = 0
  while ((m = TOKEN.exec(text)) !== null) {
    const pre = text.slice(last, m.index).trim()
    if (pre) bcast.push(pre)
    const name = (m[1] || m[2] || m[3] || '').toLowerCase()
    const isAsk = !!m[2]
    const isAll = !name || name === 'all' || name === 'everyone' || name === 'room'
    const next = text.indexOf('[', TOKEN.lastIndex)
    let chunk = (next === -1 ? text.slice(TOKEN.lastIndex) : text.slice(TOKEN.lastIndex, next)).trim()
    // Short form carries the message INSIDE the brackets ([ask @x: q]).
    // Fall back to inner text when nothing follows the closing bracket.
    if (!chunk) {
      const inner = (m[4] || '').trim().replace(/^[:,\s]+/, '')
      if (inner) chunk = inner
    }
    if (isAll) {
      if (chunk) bcast.push(chunk)
    } else if (rosterSet.has(name)) {
      result.relays.push({ target: name, text: chunk, ask: isAsk })
    } else {
      if (chunk) bcast.push(chunk)
    }
    last = next === -1 ? text.length : next
  }
  const tail = text.slice(last).trim()
  if (tail) bcast.push(tail)
  result.broadcast = bcast.join(' ').trim()
  return result
}

/** Build the digest string from the timeline (latest DIGEST_LEN entries). */
function buildDigest(timeline, n = DIGEST_LEN) {
  const t = timeline || []
  const rows = t.slice(-n).map((msg) => {
    const who = typeof msg.from === 'string' ? msg.from : (msg.from || {}).profile || '?'
    const tail = msg.to ? ` → @${msg.to}` : ''
    const body = String(msg.text || '')
    const clipped = body.length > 220 ? body.slice(0, 217) + '…' : body
    return `@${who}${tail}: ${clipped}`
  })
  return rows.length ? rows.join('\n') : '(room is quiet)'
}

/**
 * The room brief seeded into a member session on mint/fresh-context.
 * Tells each agent who else is in the room, the grammar, and the current state.
 * `timeline` is passed in for pure/testable construction.
 */
function buildRoomBrief(member, members, title, isBrowserAgent, timeline) {
  const roster = [...members, { profile: 'you' }]
    .map((m) => '@' + _normalize(m.profile))
    .join(', ')
  const digest = buildDigest(timeline, DIGEST_LEN)
  return (
    `You are @${_normalize(member.profile)}, a member of the Hermes room "${title}".\n` +
    `Roster (use ONLY these names to address members): ${roster}.\n` +
    (isBrowserAgent
      ? `You are the room's BROWSER AGENT. When live or current information is needed, use browser_navigate / browser_snapshot / browser_click / web_extract to fetch and verify it yourself.\n`
      : '') +
    `\nCOORDINATION RULES (follow exactly):\n` +
    `- Direct a teammate privately:  [to @name] message\n` +
    `- Ask one member a question:    [ask @name] question\n` +
    `- Address the whole room:       [all] message\n` +
    `- No marker = the message is addressed to you; answer it.\n` +
    `- Never invent teammates; use only the roster above.\n` +
    `\nROOM DIGEST (latest state):\n${digest}`
  )
}

/** Find bare `@name` roster mentions in a user post (composer shorthand). */
function extractMentions(text, roster) {
  const rosterSet = new Set((roster || []).map(_normalize))
  const found = []
  const re = /@([a-z0-9._-]+)/g
  let m
  while ((m = re.exec(text || '')) !== null) {
    const name = m[1].toLowerCase()
    if (rosterSet.has(name) && !found.includes(name)) found.push(name)
  }
  return found
}

/**
 * Route a user post: bracket directives win; otherwise bare @mentions target
 * members; otherwise broadcast to everyone.
 */
function routeUserPost(text, members) {
  const roster = (members || []).map((m) => m.profile)
  const parsed = parseCoordination(text, roster)
  if (parsed.relays.length) return parsed
  const mentions = extractMentions(text, roster)
  if (mentions.length) {
    const body = (text || '').replace(/@[a-z0-9._-]+/g, '').replace(/\s{2,}/g, ' ').trim()
    return {
      relays: mentions.map((t) => ({ target: t, text: body, ask: false })),
      broadcast: ''
    }
  }
  return parsed
}

// --CORE-END--

/**
 * Status mapping from gateway events → member status.
 */
function statusForEvent(e) {
  const t = e && e.type
  if (t === 'assistant.delta' || t === 'message.delta' || t === 'thinking.delta') return 'streaming'
  if (t === 'assistant.completed') return 'done'
  if (t === 'done' || t === 'error') return 'idle'
  return null
}

// ── router / relay (side effects: host.request) ─────────────────────────────

function memberBySession(sessionId, profile) {
  const list = $members.get()
  return list.find((m) => m.sessionId === sessionId || (profile && _normalize(m.profile) === _normalize(profile)))
}

async function deliverTo(member, text, opts = {}) {
  if (!member || !member.sessionId) {
    host.notify({ kind: 'warning', message: `Hive: ${member ? member.profile : 'member'} has no live session — forge it first.` })
    return
  }
  const payload =
    `[room digest]\n${buildDigest($timeline.get(), DIGEST_LEN)}\n\n` +
    (opts.from ? `from @${opts.from}:\n` : '') +
    text
  const busy = member.status === 'streaming' || member.status === 'thinking'
  try {
    await host.request('prompt.submit', {
      session_id: member.sessionId,
      text: payload,
      ...(busy && !opts.system ? { queued: true } : {})
    })
  } catch (err) {
    host.notifyError(err, `Hive: deliver to @${member.profile} failed`)
  }
}

async function deliverToAll(text, opts) {
  for (const m of $members.get()) await deliverTo(m, text, opts)
}

// last-relay echo guard: prevent A→B→A verbatim loops
const _lastRelay = new Map() // profile -> last text delivered to them
function guardEcho(target, text) {
  const key = _normalize(target)
  if (_lastRelay.get(key) === text) return false
  _lastRelay.set(key, text)
  return true
}

function appendTimeline(msg) {
  const t = $timeline.get()
  $timeline.set([...t, { id: Math.random().toString(36).slice(2, 9), ts: Date.now(), ...msg }].slice(-200))
}

async function handleAssistantDone(e) {
  const member = memberBySession(e.session_id, e.profile)
  if (!member) return
  const content = (e.content || '').trim()
  if (!content) return

  const parsed = parseCoordination(content, $members.get().map((m) => m.profile))
  const from = _normalize(member.profile)

  // Render the member's own message (markers stripped) in the timeline.
  const visible = [parsed.broadcast, ...parsed.relays.map((r) => r.text)].filter(Boolean).join(' ')
  if (visible) appendTimeline({ from, kind: 'agent', text: visible, to: null })

  // Relays to teammates.
  for (const r of parsed.relays) {
    const target = $members.get().find((m) => _normalize(m.profile) === r.target)
    if (!target || !guardEcho(r.target, r.text)) continue
    appendTimeline({ from, kind: 'relay', text: r.text, to: r.target })
    await deliverTo(target, r.text, { from })
  }

  // Broadcast → digest.
  if (parsed.broadcast) {
    // deliver broadcast to everyone so the room stays coherent
    await deliverToAll(parsed.broadcast, { from })
  }
}

function markStatus(sessionId, profile, status) {
  const list = $members.get()
  const idx = list.findIndex(
    (m) => m.sessionId === sessionId || (profile && _normalize(m.profile) === _normalize(profile))
  )
  if (idx !== -1 && list[idx].status !== status) {
    const next = list.slice()
    next[idx] = { ...next[idx], status }
    $members.set(next)
  }
}

// ── profile list + session management ───────────────────────────────────────

async function fetchProfiles() {
  try {
    const api = window && window.hermesDesktop && window.hermesDesktop.api
    if (!api) return []
    const res = await api({ path: '/api/profiles' })
    return (res && res.profiles) || []
  } catch {
    return []
  }
}

/** Mint a live session on a profile and seed it with the room brief. */
async function mintMember(profile) {
  const list = $members.get()
  if (list.length >= MAX_MEMBERS) {
    host.notify({ kind: 'warning', message: `Hive: room is full (${MAX_MEMBERS} members).` })
    return null
  }
  const key = _normalize(profile)
  if (list.some((m) => _normalize(m.profile) === key)) return list.find((m) => _normalize(m.profile) === key)

  const params = {
    cols: 96,
    source: 'desktop',
    profile: key,
    ...($cwd.get() ? { cwd: $cwd.get() } : {})
  }
  try {
    const created = await host.request('session.create', params)
    const member = {
      profile: key,
      sessionId: created.session_id,
      storedId: created.stored_session_id || null,
      status: 'idle',
      browser: false
    }
    $members.set([...list, member])
    const isBrowser = !$members.get().some((m) => m.browser)
    if (isBrowser) {
      member.browser = true
      $members.set($members.get().map((m) => (m.profile === key ? member : m)))
    }
    await deliverTo(member, buildRoomBrief(member, $members.get(), $title.get(), member.browser, $timeline.get()), { system: true })
    appendTimeline({ from: 'system', kind: 'system', text: `@${key} joined the room`, to: null })
    persist()
    return member
  } catch (err) {
    host.notifyError(err, `Hive: couldn't start @${key}`)
    return null
  }
}

function removeMember(profile) {
  $members.set($members.get().filter((m) => _normalize(m.profile) !== _normalize(profile)))
  persist()
}

/** Fresh context: mint a brand-new session for a member, re-seed the brief. */
async function freshContext(profile) {
  const key = _normalize(profile)
  const old = $members.get().find((m) => _normalize(m.profile) === key)
  if (old) $members.set($members.get().filter((m) => m !== old))
  await mintMember(key)
}

async function setBrowser(profile, on) {
  const list = $members.get()
  const key = _normalize(profile)
  const next = list.map((m) =>
    m.profile === key
      ? { ...m, browser: !!on }
      : on
        ? { ...m, browser: false } // single holder
        : m
  )
  // Re-seed the (new) holder + the demoted member with updated briefs.
  $members.set(next)
  const holder = next.find((m) => m.profile === key && m.browser)
  const demoted = list.find((m) => m.browser && m.profile !== key)
  if (holder) await deliverTo(holder, buildRoomBrief(holder, next, $title.get(), true, $timeline.get()), { system: true })
  if (demoted && !demoted.browser) {
    const fresh = next.find((m) => m.profile === demoted.profile)
    if (fresh) await deliverTo(fresh, buildRoomBrief(fresh, next, $title.get(), false, $timeline.get()), { system: true })
  }
  persist()
}

// ── persistence ─────────────────────────────────────────────────────────────

function persist() {
  if (!storageRef) return
  const data = {
    title: $title.get(),
    cwd: $cwd.get(),
    members: $members
      .get()
      .map((m) => ({ profile: m.profile, storedId: m.storedId, browser: m.browser }))
  }
  storageRef.set(STORAGE_KEY, data)
}

/** Best-effort reconnect to stored sessions; detaches any that are gone. */
async function bootHydrate() {
  if (!storageRef) return
  const saved = storageRef.get(STORAGE_KEY, null)
  if (!saved || !Array.isArray(saved.members)) {
    // seed the default agent so the room has at least one working member
    await mintMember('default')
    persist()
    return
  }
  $title.set(saved.title || 'hive')
  $cwd.set(saved.cwd || '')
  const hydrated = []
  for (const m of saved.members) {
    const live = { profile: m.profile, storedId: m.storedId || null, browser: !!m.browser, status: 'idle', sessionId: null }
    if (live.storedId) {
      try {
        const info = await host.request('session.info', { session_id: live.storedId })
        if (info && info.session_id) live.sessionId = info.session_id
      } catch {
        live.sessionId = null
      }
    }
    hydrated.push(live)
  }
  $members.set(hydrated)
}

// ── UI: pane ────────────────────────────────────────────────────────────────

function RosterChip({ m }) {
  const color = profileColor(m.profile)
  const statusTone =
    m.status === 'streaming' ? 'warn' : m.status === 'done' ? 'good' : m.status === 'error' ? 'bad' : 'muted'
  return jsx(DropdownMenu, {
    children: [
      jsx(DropdownMenuTrigger, {
        asChild: true,
        children: jsx('div', {
          'data-role': 'member',
          style: { borderColor: color },
          className: cn(
            'flex cursor-pointer items-center gap-1.5 rounded-lg border bg-background/60 px-2 py-1 text-xs select-none',
            m.browser && 'ring-1'
          ),
          children: [
            jsx(StatusDot, { tone: statusTone }),
            jsx('span', { style: { color }, className: 'font-medium', children: '@' + m.profile }),
            m.browser && jsx(icons.Globe, { size: 13, style: { color } })
          ]
        })
      }),
      jsx(DropdownMenuContent, {
        align: 'start',
        children: [
          jsx(DropdownMenuItem, { onSelect: () => { void setBrowser(m.profile, !m.browser) }, children: m.browser ? 'Release browser control' : 'Grant browser control' }),
          jsx(DropdownMenuItem, { onSelect: () => { void freshContext(m.profile) }, children: 'Fresh context (new session)' }),
          jsx(DropdownMenuItem, { variant: 'destructive', onSelect: () => removeMember(m.profile), children: 'Remove from room' })
        ]
      })
    ]
  })
}

function MemberTone({ t, from, to, text }) {
  const color = from === 'you' ? null : profileColor(from)
  const label = from === 'system' ? '·' : '@' + from + (to ? ' → @' + to : '')
  return jsx('div', {
    className: 'group flex flex-col gap-0.5',
    children: [
      jsx('div', { className: 'flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground', children: [
        from !== 'system' && jsx('span', { style: color ? { color } : undefined, className: 'font-semibold', children: label }),
        from === 'system' && jsx('span', { className: 'italic', children: label })
      ] }),
      jsx('div', { className: cn('whitespace-pre-wrap text-sm leading-relaxed', from === 'system' && 'italic text-muted-foreground'), children: text })
    ]
  })
}

function Timeline() {
  const timeline = useValue($timeline)
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [timeline.length])
  return jsx(ScrollArea, {
    ref,
    className: 'h-full grow min-h-0',
    children: jsx('div', {
      className: 'flex flex-col gap-2 p-2',
      'data-hive-timeline': true,
      children: timeline.length
        ? timeline.map((m) => jsx(MemberTone, { key: m.id, t: m.t, from: m.from, to: m.to, text: m.text }))
        : jsx('div', { className: 'p-4 text-center text-xs text-muted-foreground', children: 'Room is empty. Add profiles or message @default.' })
    })
  })
}

function Composer() {
  const composer = useValue($composer)
  const members = useValue($members)
  const open = useValue($mentionOpen)
  const ref = useRef(null)
  const q = open.toLowerCase()

  const matches = useMemo(() => {
    if (!open) return []
    return members
      .map((m) => '@' + m.profile)
      .concat(['@you'])
      .filter((n) => n.toLowerCase().includes(q))
      .slice(0, 6)
  }, [open, members])

  const post = () => {
    const raw = composer.trim()
    if (!raw) return
    haptic('tap')
    $composer.set('')
    $mentionOpen.set('')
    const parsed = routeUserPost(raw, members)
    if (parsed.relays.length) {
      for (const r of parsed.relays) {
        const target = members.find((m) => _normalize(m.profile) === r.target)
        if (target) {
          appendTimeline({ from: 'you', kind: 'relay', text: r.text, to: r.target })
          void deliverTo(target, r.text, { from: 'you' })
        }
      }
    } else {
      appendTimeline({ from: 'you', kind: 'user', text: parsed.broadcast, to: null })
      void deliverToAll(parsed.broadcast, { from: 'you' })
    }
    persist()
  }

  const onChange = (v) => {
    $composer.set(v)
    const toks = v.split(/\s+/)
    const last = toks[toks.length - 1] || ''
    $mentionOpen.set(last.startsWith('@') ? last.slice(1) : '')
  }

  return jsxs('div', {
    className: 'border-t p-2 flex flex-col gap-1.5',
    'data-hive-composer': true,
    children: [
      open &&
        matches.length > 0 &&
        jsx('div', {
          className: 'flex flex-wrap gap-1 pb-1',
          children: matches.map((name) =>
            jsx(Button, {
              key: name,
              variant: 'outline',
              size: 'sm',
              onClick: () => {
                const toks = $composer.get().split(/\s+/)
                toks[toks.length - 1] = name + ' '
                $composer.set(toks.join(' '))
                $mentionOpen.set('')
                ref.current?.focus?.()
              },
              children: name
            })
          )
        }),
      jsx(Textarea, {
        ref,
        value: composer,
        placeholder: 'Message the room…  use @name (or [to @name]) to tag a member',
        rows: 2,
        className: 'resize-none text-sm',
        'data-testid': 'hive-composer',
        onChange: (ev) => onChange(ev.target.value),
        onKeyDown: (ev) => {
          if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault()
            post()
          }
        }
      }),
      jsx(Button, { onClick: post, disabled: !composer.trim(), className: 'self-end', children: jsxs('span', { children: ['Send to room ', jsx(icons.Send, { size: 13, className: 'inline' })] }) })
    ]
  })
}

function renderOptions(opts) {
  return jsx('div', {
    className: 'flex flex-col gap-0.5 max-h-48 overflow-auto',
    children: opts.length
      ? opts.map((p) =>
          jsx(Button, {
            key: p.name,
            variant: 'ghost',
            size: 'sm',
            className: 'justify-start text-xs',
            onClick: () => {
              void mintMember(p.name)
              setOpen(false)
              setQ('')
            },
            children: jsxs('div', { className: 'flex items-center gap-1.5', children: [
              jsx('span', { style: { color: profileColor(p.name) }, children: '@' + p.name }),
              jsx('span', { className: 'text-[10px] text-muted-foreground', children: p.model || 'no model' })
            ] })
          })
        )
      : jsx('div', { className: 'p-2 text-xs text-muted-foreground', children: 'No more profiles to add.' })
  })
}

function AddMember() {
  const [q, setQ] = useState('')
  const [profiles, setProfiles] = useState([])
  const [open, setOpen] = useState(false)
  const load = () => {
    void fetchProfiles().then((p) => {
      setProfiles(p)
      setOpen(true)
    })
  }
  const members = useValue($members)
  const present = new Set(members.map((m) => _normalize(m.profile)).concat(['you']))
  const opts = profiles
    .filter((p) => !present.has(_normalize(p.name)))
    .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 8)

  return jsxs('div', {
    className: 'relative',
    children: [
      open &&
        jsxs('div', {
          className: 'absolute z-20 right-0 top-9 w-56 rounded-lg border bg-background p-2 shadow-lg',
          children: [
            jsx(Input, { autoFocus: true, placeholder: 'Search profiles…', value: q, onChange: (e) => setQ(e.target.value), className: 'mb-1.5 text-xs' }),
            renderOptions(opts)
          ]
        }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: load, children: jsxs('span', { children: [jsx(icons.Plus, { size: 13, className: 'inline mr-1' }), 'Add agent'] }) })
    ]
  })
}

function HivePane() {
  const members = useValue($members)
  const title = useValue($title)
  return jsxs('div', {
    'data-hive-pane': true,
    className: 'flex h-full flex-col bg-background',
    style: { minHeight: 0 },
    children: [
      jsxs('div', { className: 'flex items-center justify-between border-b px-3 py-2', children: [
        jsxs('div', { className: 'flex items-center gap-2', children: [
          jsx('span', { className: 'text-sm font-semibold', children: 'Hive' }),
          jsx(Badge, { variant: 'secondary', children: title }),
          jsx(Badge, { variant: 'outline', children: members.length + '/10' })
        ] }),
        jsx(AddMember, {})
      ] }),
      jsx('div', { className: 'flex flex-col gap-1.5 p-2 border-b', children: members.map((m) => jsx(RosterChip, { key: m.profile, m })) }),
      jsx(Timeline, {}),
      jsx(Composer, {})
    ]
  })
}

// ── register ────────────────────────────────────────────────────────────────
export default {
  id: PLUGIN_ID,
  name: 'Buzz-Hive',

  register(ctx) {
    storageRef = ctx.storage

    // Migration guard: ensure we're reading a consistent v1 shape.
    const raw = ctx.storage.get(STORAGE_KEY, null)
    if (raw && (!raw.members || !Array.isArray(raw.members))) {
      ctx.storage.set(STORAGE_KEY, { title: 'hive', cwd: '', members: [] })
    }

    void bootHydrate()

    const disposers = []

    disposers.push(
      ctx.register({
        id: 'pane',
        area: 'panes',
        title: 'hive',
        data: { placement: 'right', width: '380px', minWidth: '300px', maxWidth: '560px' },
        render: () => jsx(HivePane, {})
      })
    )

    disposers.push(
      ctx.register({
        id: 'palette-open',
        area: 'palette',
        data: {
          id: 'buzz-hive-open',
          label: 'Hive: open the agent room',
          keywords: ['hive', 'buzz', 'room', 'agents', 'multi'],
          run: () => host.notify({ kind: 'info', message: 'Hive room is the right-hand pane.' })
        }
      })
    )

    disposers.push(host.onEvent('assistant.completed', (e) => {
      markStatus(e.session_id, e.profile, 'done')
      void handleAssistantDone(e)
    }))
    disposers.push(host.onEvent('assistant.delta', (e) => markStatus(e.session_id, e.profile, 'streaming')))
    disposers.push(host.onEvent('message.delta', (e) => markStatus(e.session_id, e.profile, 'streaming')))
    disposers.push(host.onEvent('thinking.delta', (e) => markStatus(e.session_id, e.profile, 'streaming')))

    ctx.onDispose(() => {
      disposers.forEach((d) => {
        try { d() } catch { /* noop */ }
      })
    })
  }
}
