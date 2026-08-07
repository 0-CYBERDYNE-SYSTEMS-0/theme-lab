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
 *  - create profile                  → POST /api/profiles {name, clone_from}
 *  - mint a member session           → host.request('session.create', {profile,...})
 *  - inject into any session         → host.request('prompt.submit',{session_id,text})
 *  - hear a member's finished turn   → host.onEvent('assistant.completed', e) e.content
 *
 * QA hardening (Aug 2026):
 *  - ALL top-level identifiers are hive-prefixed: the packaged runtime
 *    evaluates plugin code in a scope where generic names collide with bundle
 *    chunks (theme-forge died with "Identifier 'normalizeViewMode' has already
 *    been declared"). Namespacing eliminates that class of load failure.
 *  - Add-member popover renderOptions no longer closes over React state
 *    setters it can't see (was a render-time ReferenceError).
 *  - Profile list has a desktop-bridge path + manual-entry fallback, and a
 *    "New profile…" create route (mirrors the app's CreateProfileDialog).
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
const HIVE_PLUGIN_ID = 'buzz-hive'
const HIVE_MAX_MEMBERS = 10 // profile members (You is extra, pinned)
const HIVE_DIGEST_LEN = 12
const HIVE_STORAGE_KEY = 'hive.v1'
const HIVE_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

// ── reactive state ──────────────────────────────────────────────────────────
const $hiveMembers = atom([]) // { profile, sessionId, storedId, status, browser }
const $hiveTimeline = atom([]) // { id, ts, from, kind:'user'|'agent'|'relay'|'system', text, to? }
const $hiveTitle = atom('hive')
const $hiveCwd = atom('')
const $hiveComposer = atom('')
const $hiveMentionOpen = atom('') // autocomplete filter when composing @name
// Live per-member stream buffers for in-flight feedback:
//   { [profile]: { text: string, tool: string } }  — text = accumulated deltas
const $hiveStreams = atom({})
// Completion dedup: map sessionId -> timestamp of last processed completion,
// so message.complete and assistant.completed for the same turn fire once.
const _hiveProcessed = new Map()

// module refs set in register()
let hiveStorageRef = null

// ── create-CORE-BEGIN (pure functions; sliced verbatim by test.cjs) ────────

const hiveNormalize = (name) => ((name || '').trim() || 'default').toLowerCase()

/**
 * Parse a member's finished output (or a user post) into coordination actions.
 * Machine grammar (agents are taught it in the room brief):
 *   [to @name] text   → private relay to that member
 *   [ask @name] text  → relay + flagged as a question
 *   [all] text        → broadcast (timeline + digest)
 *   [@name] text      → private relay to that member
 * Short form: [ask @x: question] — message inside the brackets is used when
 * nothing follows the closing bracket.
 * Returns { relays:[{target,text,ask}], broadcast:string }.
 */
function hiveParseCoordination(content, roster) {
  const result = { relays: [], broadcast: '' }
  const text = (content || '').trim()
  if (!text) return { relays: [], broadcast: text }
  const rosterSet = new Set((roster || []).map(hiveNormalize))
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
function hiveBuildDigest(timeline, n = HIVE_DIGEST_LEN) {
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
function hiveBuildRoomBrief(member, members, title, isBrowserAgent, timeline) {
  const roster = [...members, { profile: 'you' }]
    .map((m) => '@' + hiveNormalize(m.profile))
    .join(', ')
  const digest = hiveBuildDigest(timeline, HIVE_DIGEST_LEN)
  return (
    `You are @${hiveNormalize(member.profile)}, a member of the Hermes room "${title}".\n` +
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
function hiveExtractMentions(text, roster) {
  const rosterSet = new Set((roster || []).map(hiveNormalize))
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
function hiveRouteUserPost(text, members) {
  const roster = (members || []).map((m) => m.profile)
  const parsed = hiveParseCoordination(text, roster)
  if (parsed.relays.length) return parsed
  const mentions = hiveExtractMentions(text, roster)
  if (mentions.length) {
    const body = (text || '').replace(/@[a-z0-9._-]+/g, '').replace(/\s{2,}/g, ' ').trim()
    return {
      relays: mentions.map((t) => ({ target: t, text: body, ask: false })),
      broadcast: ''
    }
  }
  return parsed
}

/** Mirrors the app's CreateProfileDialog name validation. */
function hiveIsValidProfileName(name) {
  return HIVE_PROFILE_NAME_RE.test((name || '').trim())
}

// --CORE-END--

/**
 * Status mapping from gateway events → member status.
 */
function hiveStatusForEvent(e) {
  const t = e && e.type
  if (t === 'assistant.delta' || t === 'message.delta' || t === 'thinking.delta') return 'streaming'
  if (t === 'assistant.completed') return 'done'
  if (t === 'done' || t === 'error') return 'idle'
  return null
}

// ── router / relay (side effects: host.request) ─────────────────────────────

function hiveMemberBySession(sessionId, profile) {
  const list = $hiveMembers.get()
  return list.find(
    (m) => m.sessionId === sessionId || (profile && hiveNormalize(m.profile) === hiveNormalize(profile))
  )
}

async function hiveDeliverTo(member, text, opts = {}) {
  if (!member || !member.sessionId) {
    host.notify({
      kind: 'warning',
      message: `Hive: @${member ? member.profile : '?'} has no live session — click it and choose "Fresh context", or re-add it.`
    })
    return
  }
  const payload =
    `[room digest]\n${hiveBuildDigest($hiveTimeline.get(), HIVE_DIGEST_LEN)}\n\n` +
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

async function hiveDeliverToAll(text, opts) {
  for (const m of $hiveMembers.get()) await hiveDeliverTo(m, text, opts)
}

// last-relay echo guard: prevent A→B→A verbatim loops
const _hiveLastRelay = new Map() // profile -> last text delivered to them
function hiveGuardEcho(target, text) {
  const key = hiveNormalize(target)
  if (_hiveLastRelay.get(key) === text) return false
  _hiveLastRelay.set(key, text)
  return true
}

function hiveAppendTimeline(msg) {
  const t = $hiveTimeline.get()
  $hiveTimeline.set([...t, { id: Math.random().toString(36).slice(2, 9), ts: Date.now(), ...msg }].slice(-200))
}

/** Reset a member's live stream buffer (turn start). */
function hiveStreamReset(profile) {
  const s = $hiveStreams.get()
  $hiveStreams.set({ ...s, [hiveNormalize(profile)]: { text: '', tool: '' } })
}

/** Append an incremental delta chunk to a member's live buffer. */
function hiveStreamAppend(profile, text) {
  const key = hiveNormalize(profile)
  const s = $hiveStreams.get()
  $hiveStreams.set({ ...s, [key]: { ...(s[key] || { text: '', tool: '' }), text: (s[key]?.text || '') + (text || '') } })
}

function hiveStreamSetTool(profile, tool) {
  const key = hiveNormalize(profile)
  const s = $hiveStreams.get()
  $hiveStreams.set({ ...s, [key]: { ...(s[key] || { text: '', tool: '' }), tool: tool || '' } })
}

function hiveStreamClear(profile) {
  const key = hiveNormalize(profile)
  const s = $hiveStreams.get()
  if (!(key in s)) return
  const next = { ...s }
  delete next[key]
  $hiveStreams.set(next)
}

/** Process a member's finished turn: render, relay, broadcast. `content` is the
 *  final accumulated text; dedup guards the same turn arriving on both
 *  message.complete and assistant.completed. */
async function hiveHandleAssistantDone(e, content) {
  const member = hiveMemberBySession(e.session_id, e.profile)
  if (!member) return

  const now = Date.now()
  const last = _hiveProcessed.get(e.session_id) || 0
  if (now - last < 1500) return // already processed this turn
  _hiveProcessed.set(e.session_id, now)

  hiveStreamClear(member.profile)
  hiveMarkStatus(e.session_id, e.profile, 'done')

  const finalText = (content || '').trim()
  if (!finalText) return

  const parsed = hiveParseCoordination(finalText, $hiveMembers.get().map((m) => m.profile))
  const from = hiveNormalize(member.profile)

  // Render the member's own message (markers stripped) in the timeline.
  const visible = [parsed.broadcast, ...parsed.relays.map((r) => r.text)].filter(Boolean).join(' ')
  if (visible) hiveAppendTimeline({ from, kind: 'agent', text: visible, to: null })

  // Relays to teammates.
  for (const r of parsed.relays) {
    const target = $hiveMembers.get().find((m) => hiveNormalize(m.profile) === r.target)
    if (!target || !hiveGuardEcho(r.target, r.text)) continue
    hiveAppendTimeline({ from, kind: 'relay', text: r.text, to: r.target })
    await hiveDeliverTo(target, r.text, { from })
  }

  // Broadcast → digest.
  if (parsed.broadcast) {
    await hiveDeliverToAll(parsed.broadcast, { from })
  }
}

/** Fallback completion signal (some surfaces emit assistant.completed instead
 *  of message.complete). Uses the accumulated buffer when the payload has no
 *  content. */
async function hiveHandleFallbackCompleted(e) {
  const member = hiveMemberBySession(e.session_id, e.profile)
  if (!member) return
  const buffered = $hiveStreams.get()[hiveNormalize(member.profile)]?.text || ''
  const content = (e.content || '').trim() || buffered
  if (!content) return
  await hiveHandleAssistantDone(e, content)
}

function hiveMarkStatus(sessionId, profile, status) {
  const list = $hiveMembers.get()
  const idx = list.findIndex(
    (m) => m.sessionId === sessionId || (profile && hiveNormalize(m.profile) === hiveNormalize(profile))
  )
  if (idx !== -1 && list[idx].status !== status) {
    const next = list.slice()
    next[idx] = { ...next[idx], status }
    $hiveMembers.set(next)
  }
}

// ── profile list + session management ───────────────────────────────────────

async function hiveFetchProfiles() {
  try {
    const api = window && window.hermesDesktop && window.hermesDesktop.api
    if (!api) throw new Error('desktop bridge unavailable')
    const res = await api({ path: '/api/profiles' })
    return (res && res.profiles) || []
  } catch {
    return []
  }
}

/** Create a profile via the desktop bridge, mirroring the app's dialog. */
async function hiveCreateProfile(name, cloneFrom, soul) {
  const api = window && window.hermesDesktop && window.hermesDesktop.api
  if (!api) throw new Error('Desktop bridge unavailable — create the profile in Settings → Profiles instead.')
  const trimmed = (name || '').trim()
  if (!hiveIsValidProfileName(trimmed)) {
    throw new Error('Profile names: lowercase letters, digits, - and _ (start with a letter/digit).')
  }
  const res = await api({ path: '/api/profiles', method: 'POST', body: { name: trimmed, clone_from: cloneFrom } })
  if (soul && soul.trim()) {
    await api({ path: `/api/profiles/${encodeURIComponent(trimmed)}/soul`, method: 'PUT', body: { content: soul.trim() } })
  }
  return res
}

/** Mint a live session on a profile and seed it with the room brief. */
async function hiveMintMember(profile) {
  const list = $hiveMembers.get()
  if (list.length >= HIVE_MAX_MEMBERS) {
    host.notify({ kind: 'warning', message: `Hive: room is full (${HIVE_MAX_MEMBERS} members).` })
    return null
  }
  const key = hiveNormalize(profile)
  const existing = list.find((m) => hiveNormalize(m.profile) === key)
  if (existing) return existing

  const params = {
    cols: 96,
    source: 'desktop',
    profile: key,
    ...($hiveCwd.get() ? { cwd: $hiveCwd.get() } : {})
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
    $hiveMembers.set([...$hiveMembers.get(), member])
    // First member holds the browser role by default.
    if (!$hiveMembers.get().some((m) => m.browser)) {
      $hiveMembers.set($hiveMembers.get().map((m) => (hiveNormalize(m.profile) === key ? { ...m, browser: true } : m)))
    }
    const current = $hiveMembers.get().find((m) => hiveNormalize(m.profile) === key)
    await hiveDeliverTo(current, hiveBuildRoomBrief(current, $hiveMembers.get(), $hiveTitle.get(), current.browser, $hiveTimeline.get()), { system: true })
    hiveAppendTimeline({ from: 'system', kind: 'system', text: `@${key} joined the room`, to: null })
    hivePersist()
    return current
  } catch (err) {
    host.notifyError(err, `Hive: couldn't start @${key}`)
    return null
  }
}

function hiveRemoveMember(profile) {
  $hiveMembers.set($hiveMembers.get().filter((m) => hiveNormalize(m.profile) !== hiveNormalize(profile)))
  hivePersist()
}

/** Fresh context: mint a brand-new session for a member, re-seed the brief. */
async function hiveFreshContext(profile) {
  const key = hiveNormalize(profile)
  $hiveMembers.set($hiveMembers.get().filter((m) => hiveNormalize(m.profile) !== key))
  await hiveMintMember(key)
}

async function hiveSetBrowser(profile, on) {
  const list = $hiveMembers.get()
  const key = hiveNormalize(profile)
  const next = list.map((m) =>
    hiveNormalize(m.profile) === key
      ? { ...m, browser: !!on }
      : on
        ? { ...m, browser: false } // single holder
        : m
  )
  // Re-seed the (new) holder + the demoted member with updated briefs.
  $hiveMembers.set(next)
  const holder = next.find((m) => hiveNormalize(m.profile) === key && m.browser)
  const demoted = list.find((m) => m.browser && hiveNormalize(m.profile) !== key)
  if (holder) await hiveDeliverTo(holder, hiveBuildRoomBrief(holder, next, $hiveTitle.get(), true, $hiveTimeline.get()), { system: true })
  if (demoted && !demoted.browser) {
    const fresh = next.find((m) => hiveNormalize(m.profile) === hiveNormalize(demoted.profile))
    if (fresh) await hiveDeliverTo(fresh, hiveBuildRoomBrief(fresh, next, $hiveTitle.get(), false, $hiveTimeline.get()), { system: true })
  }
  hivePersist()
}

// ── persistence ─────────────────────────────────────────────────────────────

function hivePersist() {
  if (!hiveStorageRef) return
  const data = {
    title: $hiveTitle.get(),
    cwd: $hiveCwd.get(),
    members: $hiveMembers
      .get()
      .map((m) => ({ profile: m.profile, storedId: m.storedId, browser: m.browser }))
  }
  hiveStorageRef.set(HIVE_STORAGE_KEY, data)
}

/** Best-effort reconnect to stored sessions; detaches any that are gone. */
async function hiveBootHydrate() {
  if (!hiveStorageRef) return
  const saved = hiveStorageRef.get(HIVE_STORAGE_KEY, null)
  if (!saved || !Array.isArray(saved.members) || saved.members.length === 0) {
    // seed the default agent so the room has at least one working member
    await hiveMintMember('default')
    hivePersist()
    return
  }
  $hiveTitle.set(saved.title || 'hive')
  $hiveCwd.set(saved.cwd || '')
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
  $hiveMembers.set(hydrated)
}

// ── UI: pane ────────────────────────────────────────────────────────────────

function HiveRosterChip({ m }) {
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
          title: m.browser ? 'Browser agent' : m.status || 'idle',
          className: cn(
            'flex cursor-pointer items-center gap-1.5 rounded-lg border bg-background/60 px-2 py-1 text-xs select-none',
            m.browser && 'ring-1'
          ),
          children: [
            jsx(StatusDot, { tone: statusTone }),
            jsx('span', { style: { color }, className: 'font-medium', children: '@' + m.profile }),
            m.browser && jsx(icons.Globe, { size: 13, style: { color } }),
            m.status === 'streaming' &&
              jsx('span', { className: 'text-[10px] text-muted-foreground', children: '…' })
          ]
        })
      }),
      jsx(DropdownMenuContent, {
        align: 'start',
        children: [
          jsx(DropdownMenuItem, { onSelect: () => { void hiveSetBrowser(m.profile, !m.browser) }, children: m.browser ? 'Release browser control' : 'Grant browser control' }),
          jsx(DropdownMenuItem, { onSelect: () => { void hiveFreshContext(m.profile) }, children: 'Fresh context (new session)' }),
          jsx(DropdownMenuItem, { variant: 'destructive', onSelect: () => hiveRemoveMember(m.profile), children: 'Remove from room' })
        ]
      })
    ]
  })
}

function HiveMemberTone({ from, to, text }) {
  const color = from === 'you' ? null : profileColor(from)
  const label = from === 'system' ? '· hive' : '@' + from + (to ? ' → @' + to : '')
  return jsx('div', {
    className: 'flex flex-col gap-0.5',
    children: [
      jsx('div', { className: 'flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground', children: [
        from !== 'system' && jsx('span', { style: color ? { color } : undefined, className: 'font-semibold', children: label }),
        from === 'system' && jsx('span', { className: 'italic', children: label })
      ] }),
      jsx('div', { className: cn('whitespace-pre-wrap text-sm leading-relaxed', from === 'system' && 'italic text-muted-foreground'), children: text })
    ]
  })
}

function HiveLiveRow() {
  const streams = useValue($hiveStreams)
  const members = useValue($hiveMembers)
  const active = members.filter((m) => m.status === 'streaming')
  if (active.length === 0) return null
  return jsx('div', {
    className: 'flex flex-col gap-1 px-2 pb-1',
    'data-hive-live': true,
    children: active.map((m) => {
      const s = streams[hiveNormalize(m.profile)] || { text: '', tool: '' }
      const color = profileColor(m.profile)
      const preview = s.text.trim().replace(/\s+/g, ' ').slice(0, 180)
      return jsx('div', {
        key: m.profile,
        className: 'flex items-start gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs',
        children: [
          jsx('span', { style: { color }, className: 'shrink-0 font-semibold', children: '@' + m.profile }),
          jsx('span', { className: 'hive-dots shrink-0 animate-pulse text-muted-foreground', children: '•••' }),
          jsx('span', { className: 'min-w-0 flex-1 truncate text-muted-foreground', children: preview || (s.tool ? `using ${s.tool}…` : 'thinking…') })
        ]
      })
    })
  })
}

function HiveTimeline() {
  const timeline = useValue($hiveTimeline)
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
      children: [
        ...(timeline.length
          ? timeline.map((m) => jsx(HiveMemberTone, { key: m.id, from: m.from, to: m.to, text: m.text }))
          : [jsx('div', { key: 'empty', className: 'p-4 text-center text-xs text-muted-foreground', children: 'Room is empty. Add profiles or message @default.' })]),
        jsx(HiveLiveRow, { key: 'live' })
      ]
    })
  })
}

function HiveComposer() {
  const composer = useValue($hiveComposer)
  const members = useValue($hiveMembers)
  const open = useValue($hiveMentionOpen)
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
    $hiveComposer.set('')
    $hiveMentionOpen.set('')
    const parsed = hiveRouteUserPost(raw, members)
    if (parsed.relays.length) {
      for (const r of parsed.relays) {
        const target = members.find((m) => hiveNormalize(m.profile) === r.target)
        if (target) {
          hiveAppendTimeline({ from: 'you', kind: 'relay', text: r.text, to: r.target })
          // Instant feedback: mark the target streaming before message.start lands.
          hiveMarkStatus(target.sessionId, target.profile, 'streaming')
          hiveStreamReset(target.profile)
          void hiveDeliverTo(target, r.text, { from: 'you' })
        }
      }
    } else {
      hiveAppendTimeline({ from: 'you', kind: 'user', text: parsed.broadcast, to: null })
      for (const m of members) {
        hiveMarkStatus(m.sessionId, m.profile, 'streaming')
        hiveStreamReset(m.profile)
      }
      void hiveDeliverToAll(parsed.broadcast, { from: 'you' })
    }
    hivePersist()
  }

  const onChange = (v) => {
    $hiveComposer.set(v)
    const toks = v.split(/\s+/)
    const last = toks[toks.length - 1] || ''
    $hiveMentionOpen.set(last.startsWith('@') ? last.slice(1) : '')
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
                const toks = $hiveComposer.get().split(/\s+/)
                toks[toks.length - 1] = name + ' '
                $hiveComposer.set(toks.join(' '))
                $hiveMentionOpen.set('')
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

/** Options list inside the Add-agent popover. Callbacks are passed in (no
 *  stale-closure over React state that isn't in scope). */
function HiveRenderOptions({ opts, onPick, onNew }) {
  return jsxs('div', {
    className: 'flex flex-col gap-0.5 max-h-48 overflow-auto',
    children: [
      opts.length
        ? opts.map((p) =>
            jsx(Button, {
              key: p.name,
              variant: 'ghost',
              size: 'sm',
              className: 'justify-start text-xs',
              onClick: () => onPick(p),
              children: jsxs('div', { className: 'flex items-center gap-1.5', children: [
                jsx('span', { style: { color: profileColor(p.name) }, children: '@' + p.name }),
                jsx('span', { className: 'text-[10px] text-muted-foreground', children: p.model || 'no model' }),
                p.skill_count > 0 && jsx('span', { className: 'text-[10px] text-muted-foreground', children: `${p.skill_count} skills` })
              ] })
            })
          )
        : jsx('div', { className: 'p-2 text-xs text-muted-foreground', children: 'Every profile is already in the room.' }),
      jsx('div', { className: 'mt-1 border-t pt-1' }),
      jsx(Button, { variant: 'ghost', size: 'sm', className: 'justify-start text-xs', onClick: onNew, children: jsxs('span', { children: [jsx(icons.Plus, { size: 13, className: 'inline mr-1' }), 'New profile…'] }) })
    ]
  })
}

/** Inline create-profile form (mirrors the app's CreateProfileDialog). */
function HiveCreateForm({ onDone, onCancel }) {
  const [name, setName] = useState('')
  const [cloneFrom, setCloneFrom] = useState('default')
  const [soul, setSoul] = useState('')
  const [status, setStatus] = useState('idle') // idle | saving | done | error
  const [error, setError] = useState('')
  const trimmed = name.trim()
  const invalid = trimmed !== '' && !hiveIsValidProfileName(trimmed)
  const busy = status === 'saving' || status === 'done'

  async function submit() {
    if (!trimmed || invalid) {
      setError(invalid ? 'Use lowercase letters, digits, - or _ (start letter/digit).' : 'Pick a name first.')
      return
    }
    setStatus('saving')
    setError('')
    try {
      await hiveCreateProfile(trimmed, cloneFrom || null, soul)
      setStatus('done')
      onDone(trimmed)
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Create failed.')
    }
  }

  return jsxs('div', {
    className: 'flex flex-col gap-1.5 border-t p-2',
    'data-hive-create': true,
    children: [
      jsx('div', { className: 'text-xs font-medium', children: 'New profile' }),
      jsx(Input, {
        autoFocus: true,
        placeholder: 'profile-name',
        value: name,
        'aria-invalid': invalid,
        onChange: (e) => setName(e.target.value),
        className: 'text-xs'
      }),
      jsx(Input, {
        placeholder: 'Clone from (default)',
        value: cloneFrom,
        onChange: (e) => setCloneFrom(e.target.value),
        className: 'text-xs'
      }),
      jsx(Textarea, {
        placeholder: 'Optional SOUL.md / persona (blank = clone untouched)',
        value: soul,
        rows: 2,
        onChange: (e) => setSoul(e.target.value),
        className: 'resize-none text-xs'
      }),
      error && jsx('div', { className: 'text-[11px] text-destructive', children: error }),
      jsxs('div', { className: 'flex items-center justify-between', children: [
        jsx(Button, { variant: 'ghost', size: 'sm', onClick: onCancel, disabled: busy, children: 'Cancel' }),
        jsx(Button, { size: 'sm', onClick: () => void submit(), disabled: busy || !trimmed, children: status === 'saving' ? 'Creating…' : 'Create & join' })
      ] })
    ]
  })
}

function HiveAddMember() {
  const [q, setQ] = useState('')
  const [profiles, setProfiles] = useState([])
  const [open, setOpen] = useState(false)
  const [loadState, setLoadState] = useState('idle') // idle | loading | error
  const [creating, setCreating] = useState(false)
  const members = useValue($hiveMembers)
  const present = new Set(members.map((m) => hiveNormalize(m.profile)).concat(['you']))
  const opts = profiles
    .filter((p) => !present.has(hiveNormalize(p.name)))
    .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 8)

  const load = () => {
    setLoadState('loading')
    void hiveFetchProfiles().then((p) => {
      setProfiles(p)
      setLoadState('idle')
      if (p.length === 0) setLoadState('error')
      setOpen(true)
    })
  }

  const pick = (p) => {
    void hiveMintMember(p.name)
    setOpen(false)
    setQ('')
  }

  return jsxs('div', {
    className: 'relative',
    children: [
      open &&
        jsxs('div', {
          className: 'absolute z-20 right-0 top-9 w-64 rounded-lg border bg-background p-2 shadow-lg',
          children: [
            creating
              ? jsx(HiveCreateForm, {
                  onDone: (name) => {
                    setCreating(false)
                    setOpen(false)
                    setQ('')
                    void hiveMintMember(name)
                    void hiveFetchProfiles().then(setProfiles)
                  },
                  onCancel: () => setCreating(false)
                })
              : jsxs('div', { className: 'flex flex-col gap-1.5', children: [
                  jsx(Input, { autoFocus: true, placeholder: 'Search profiles…', value: q, onChange: (e) => setQ(e.target.value), className: 'mb-1 text-xs' }),
                  loadState === 'error'
                    ? jsx('div', { className: 'flex items-center justify-between p-1', children: [
                        jsx('span', { className: 'text-[11px] text-muted-foreground', children: 'Couldn’t load profiles.' }),
                        jsx(Button, { variant: 'ghost', size: 'sm', onClick: load, children: 'Retry' })
                      ] })
                    : jsx(HiveRenderOptions, { opts, onPick: pick, onNew: () => setCreating(true) })
                ] })
          ]
        }),
      jsx(Button, { variant: 'outline', size: 'sm', onClick: load, disabled: members.length >= HIVE_MAX_MEMBERS, children: jsxs('span', { children: [jsx(icons.Plus, { size: 13, className: 'inline mr-1' }), 'Add agent'] }) })
    ]
  })
}

function HivePane() {
  const members = useValue($hiveMembers)
  const title = useValue($hiveTitle)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(title)

  const commitTitle = () => {
    if (titleDraft.trim()) {
      $hiveTitle.set(titleDraft.trim().slice(0, 40))
      hivePersist()
    }
    setEditingTitle(false)
  }

  return jsxs('div', {
    'data-hive-pane': true,
    className: 'flex h-full flex-col bg-background',
    style: { minHeight: 0 },
    children: [
      jsxs('div', { className: 'flex items-center justify-between gap-2 border-b px-3 py-2', children: [
        jsxs('div', { className: 'flex items-center gap-2 min-w-0', children: [
          jsx('span', { className: 'text-sm font-semibold', children: 'Hive' }),
          editingTitle
            ? jsx(Input, {
                autoFocus: true,
                value: titleDraft,
                className: 'h-6 w-24 text-xs',
                onChange: (e) => setTitleDraft(e.target.value),
                onBlur: commitTitle,
                onKeyDown: (ev) => { if (ev.key === 'Enter') commitTitle() }
              })
            : jsx(Badge, { variant: 'secondary', className: 'cursor-pointer', onClick: () => { setTitleDraft(title); setEditingTitle(true) }, title: 'Rename room', children: title }),
          jsx(Badge, { variant: 'outline', children: members.length + 1 + '/11' })
        ] }),
        jsx(HiveAddMember, {})
      ] }),
      jsx('div', { className: 'flex flex-col gap-1.5 p-2 border-b', 'data-hive-roster': true, children: [
        jsx('div', { className: 'flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs select-none opacity-80', 'data-role': 'you', children: [
          jsx(StatusDot, { tone: 'good' }),
          jsx('span', { className: 'font-medium', children: '@you' }),
          jsx('span', { className: 'text-[10px] text-muted-foreground', children: 'you' })
        ] }),
        members.map((m) => jsx(HiveRosterChip, { key: m.profile, m }))
      ] }),
      jsx(HiveTimeline, {}),
      jsx(HiveComposer, {})
    ]
  })
}

// ── register ────────────────────────────────────────────────────────────────
export default {
  id: HIVE_PLUGIN_ID,
  name: 'Buzz-Hive',

  register(ctx) {
    hiveStorageRef = ctx.storage

    // Migration guard: ensure we're reading a consistent v1 shape.
    const raw = ctx.storage.get(HIVE_STORAGE_KEY, null)
    if (raw && (!raw.members || !Array.isArray(raw.members))) {
      ctx.storage.set(HIVE_STORAGE_KEY, { title: 'hive', cwd: '', members: [] })
    }

    void hiveBootHydrate()

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

    disposers.push(host.onEvent('message.start', (e) => {
      const m = hiveMemberBySession(e.session_id, e.profile)
      if (!m) return
      console.log(`[buzz-hive] turn start @${m.profile} session=${e.session_id}`)
      hiveStreamReset(m.profile)
      hiveMarkStatus(e.session_id, e.profile, 'streaming')
    }))
    disposers.push(host.onEvent('message.delta', (e) => {
      const m = hiveMemberBySession(e.session_id, e.profile)
      if (!m) return
      hiveStreamAppend(m.profile, (e.payload && e.payload.text) || '')
      hiveMarkStatus(e.session_id, e.profile, 'streaming')
    }))
    disposers.push(host.onEvent('thinking.delta', (e) => hiveMarkStatus(e.session_id, e.profile, 'streaming')))
    disposers.push(host.onEvent('reasoning.delta', (e) => hiveMarkStatus(e.session_id, e.profile, 'streaming')))
    disposers.push(host.onEvent('tool.start', (e) => {
      const m = hiveMemberBySession(e.session_id, e.profile)
      if (!m) return
      hiveMarkStatus(e.session_id, e.profile, 'streaming')
      hiveStreamSetTool(m.profile, (e.payload && (e.payload.tool || e.payload.name)) || '')
    }))
    disposers.push(host.onEvent('message.complete', (e) => {
      // Accumulated deltas are the source of truth for the final text.
      const m = hiveMemberBySession(e.session_id, e.profile)
      if (!m) return
      const buffered = $hiveStreams.get()[hiveNormalize(m.profile)]?.text || ''
      console.log(`[buzz-hive] turn complete @${m.profile} chars=${buffered.length}`)
      void hiveHandleAssistantDone(e, buffered)
    }))
    disposers.push(host.onEvent('assistant.completed', hiveHandleFallbackCompleted))

    ctx.onDispose(() => {
      disposers.forEach((d) => {
        try { d() } catch { /* noop */ }
      })
    })
  }
}
