# Buzz-Hive — Hermes-native agent room (spec)

A Buzz-like collaboration room that runs **inside the Hermes desktop app** as a
plugin pane. Up to 10 Hermes agent profiles share one room, plus the user and
the default agent. Everyone can @-tag anyone; the plugin is the relay.

Buzz reference: Block's Buzz (github.com/block/buzz, buzz.xyz) — "where humans
and AI agents work together in a shared workspace... agents talk through
ordinary mentions, injected into each other's active work." This spec is the
Hermes-native equivalent: the **plugin is the relay**, each profile member runs
in its own per-profile session (Hermes' native concurrent multi-profile
sockets), and coordination happens over a lightweight tag protocol.

---

## 1. Grounded facts (from `~/.hermes/hermes-agent` source, Aug 2026)

### 1.1 Concurrent sessions across profiles — native
`apps/desktop/src/store/gateway.ts:9-16`:
> Concurrent sessions across profiles need concurrent sockets... one socket per
> *other* profile that has live work. Every socket feeds the same
> handleGatewayEvent, so background sessions keep painting.

Every gateway event is tagged with the owning profile:
`gateway/platforms/api_server.py` emits e.g. `assistant.completed` and the
desktop augments each event with `profile` (`gateway.ts:233`:
`gateway.onEvent(event => g.config?.onEvent({ ...event, profile }))`).

⇒ A room can run N profiles at once; the plugin hears all their streams.

### 1.2 Profile list
`apps/desktop/src/hermes.ts:1386`:
```ts
export function getProfiles(): Promise<ProfilesResponse> {
  return window.hermesDesktop.api<ProfilesResponse>({ path: '/api/profiles', ... })
}
```
`ProfileInfo` (`types/hermes.ts:860`): `{ name, is_default, model, provider,
skill_count, path, has_env }`.

⇒ Plugin reaches it via `window.hermesDesktop.api({ path: '/api/profiles' })`.

### 1.3 Mint a session on a profile
`apps/desktop/src/app/session/hooks/use-session-actions/index.ts:149` +
`:371` — `desktopSessionCreateParams()` then:
```ts
const created = await requestGateway<SessionCreateResponse>('session.create', params)
// params: { cols, source, cwd?, profile?, model?, provider?, reasoning_effort?, fast }
// response: { session_id, stored_session_id?, info?, message_count?, messages? }
```
⇒ `host.request('session.create', { profile, cwd, cols:96, source:'desktop' })`.

### 1.4 Inject a message into any session
`apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts:606`:
```ts
const submitParams = (targetId) => ({
  session_id: targetId,
  text,
  ...(interrupted && { interrupted }),
  ...(options?.fromQueue && { queued: true })
})
```
⇒ `host.request('prompt.submit', { session_id, text })`.

### 1.5 Hear a member's finished turn
`gateway/platforms/api_server.py:3783`:
```python
await queue.put(_event_payload("assistant.completed", {
    "session_id": effective_session_id, "message_id": message_id,
    "content": final_response, "completed": True, ... }))
```
Also: `message.started`, `message.delta`, `tool.completed`, `subagent.complete`.

⇒ `host.onEvent('assistant.completed', e => …)` gives `{ profile, session_id,
message_id, content }` per member. This is where `@mentions` are parsed.

### 1.6 Plugin mechanics (SDK)
`apps/desktop/src/sdk/index.ts` + `runtime.ts` + worked example
`~/.hermes/desktop-plugins/theme-forge/plugin.js`:
- Single file `~/.hermes/desktop-plugins/<id>/plugin.js`, plain ESM, default
  export `{ id, name, register(ctx) }`.
- Imports ONLY `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`; UI via
  `jsx()/jsxs()` calls, never JSX syntax.
- `ctx.register({ id, area: 'panes', render, data: { placement, width, ... } })`
- `ctx.storage.get/set/remove` — JSON persistence, survives restarts.
- `host.request(method, params)` — gateway JSON-RPC; `host.onEvent(type, fn)`.
- `host.state.*` readonly atoms (`useValue`); `host.notify`.
- UI kit: Button, Input, Textarea, ScrollArea, Badge, StatusDot, DropdownMenu,
  icons.*, cn, profileColor, profileColorSoft, useValue, atom.

---

## 2. Room model

```
┌─────────────────────────────── ROOM PANE ───────────────────────────────┐
│ Hive · <room title>                       [⛶ detach] [⋯ menu]           │
│ ── roster (draggable, max 10 profiles) ──────────────────────────────── │
│  ◉ You          ● default   ● frontier-savant  ● builder  …  [+ Add]    │
│    (user)         (default agent)  [🖥] browser  [🖥] browser            │
│ ── room timeline ────────────────────────────────────────────────────── │
│  [09:12] You → @frontier: draft the outreach email                     │
│  [09:12] frontier ⟶ thinking…  (live streaming)                        │
│  [09:14] frontier: done — attached draft. @builder, sanity-check it.    │
│  [09:15] builder: ✅ on message 2 the CTA is weak; swapped to "…"       │
│ ─────────────────────────────────────────────────────────────────────── │
│  @frontier  Draft an email to Green Valley Farms about the audit…    [➤] │
└──────────────────────────────────────────────────────────────────────────┘
```

### Members
- **You** — pinned identity. Posts go into the room and are relayed.
- **default** — the default agent, always present, can be removed.
- Up to **8 more profiles** (max 10 members incl. You + default). Dragged from
  the profile picker (searches `/api/profiles`).
- Each profile member has: a **session** (minted via `session.create` on that
  profile), a **status** (idle / thinking / streaming / done / error), a
  **browser toggle** (who holds the browser), and a **fresh-context** button
  (starts a new session for that member with the room brief re-seeded).

### Session lifecycle
- On join: `session.create({ profile, cwd: room cwd, cols:96, source:'desktop' })`.
  `session_id` is the live id; `stored_session_id` is persisted so the session
  survives restarts (re-resume via `session.resume` if it appears in the list).
- Fresh context: `session.create` again; old session left in history.
- The room brief is the first `prompt.submit` into the member session (see §4).

### Coordination protocol (tag grammar)
The relay recognizes these markers in any agent output (`assistant.completed`
content) and in user posts:
- `[to @name] message` or `[@name:] message` → **private relay** to that member.
- `@name …` at line start with a message → relay to that member.
- `[all] message` / `@room` → broadcast: appended to the room digest, shown in
  the timeline, included in the next digest sent to every member.
- `[ask @name: question]` → relay + tag the room digest as a pending question.
- Everything else → room broadcast (timeline + digest).

Agents are taught the grammar in their room brief and reminded in the digest:
"To direct a teammate, start a line with `[to @name]`. To address the room, use
`[all]`. You share the room with: …".

### Browser control
- One member holds the **browser shield** (`🖥`). Toggle is per-member,
  single-holder (turning it on for one turns it off for the previous holder).
- The holder's room brief includes: "You are the room's browser agent. Use
  browser_navigate / browser_click / browser_snapshot / web_extract to fetch
  and verify live information when asked."
- Requirement (honest): the holding profile must have the browser/web toolset
  enabled in its config. The plugin toasts a warning if the profile list
  reports no model (an unconfigured profile won't have tools) and tells the
  user to configure it in Settings → Profiles.

### Awareness without shared memory
Hermes agents have no live shared memory. Awareness is achieved by protocol:
- Each member session is seeded with the **roster + grammar + current digest**.
- The plugin prepends a **fresh digest** (last ~N room messages) to every
  incoming relayed message, so each agent always knows the current room state
  when it thinks.
- The digest is rebuilt on every room event (cheap string concat).

---

## 3. Plugin architecture

```
buzz-hive/
  plugin.js          # single-file ESM plugin (SDK surface only)
  test.cjs           # Node logic harness for pure functions (§8)
  DESIGN.md          # this file
```

### State (module-level nanostore atoms, like theme-forge)
- `$room` — `{ title, members: Member[], digest, timeline: RoomMsg[], cwd }`
- `Member` — `{ id, profile, sessionId, storedId, status, browser, color }`
- `RoomMsg` — `{ id, ts, from, kind: 'user'|'agent'|'relay'|'system', text, targets? }`

### Persistence (`ctx.storage`)
- Key `hive.v1` → `{ title, members:[{profile, storedId, browser}], cwd }`.
  Re-hydrated on register; sessions re-resumed/forged on boot.
- Migration guard: read `hive.v1`, if absent treat as fresh room.

### RPC / event wiring (`register(ctx)`)
- `host.onEvent('assistant.completed', onAssistantDone)`
- `host.onEvent('message.delta', onDelta)` — live "thinking…" indicator.
- `host.onEvent('tool.completed', onTool)` — feed activity to timeline.
- `ctx.register` a right pane: `placement:'right', width:'380px'`.
- `ctx.register` a palette command: "Hive: open agent room".

### Key functions (pure, testable)
- `parseCoordination(content, roster)` → `{ broadcasts:[], relays:[{target, text}], asks:[…] }`
- `buildRoomBrief(member, roster, digest, isBrowserAgent)` → string
- `buildDigest(timeline, n)` → string
- `routeUserPost(text, roster)` → `{ relays:[…], broadcast }`
- `statusForEvent(e)` → 'streaming' | 'done' | 'error'

---

## 4. The room brief (seeded into each member session)

```
You are <name>, a member of the Hermes room "<title>".
Roster: @you (the user), @default, @builder, @frontier …
You are the browser agent. Use browser_navigate/browser_click/browser_snapshot
when live information is needed.    ← only for the browser holder

COORDINATION RULES (follow exactly):
- To direct a teammate privately, start a line with: [to @name] message
- To address the whole room, start a line with: [all] message
- To ask one member a question: [ask @name: question]
- If a message has no marker, treat it as addressed to you.
- Never invent teammates. Use only the roster names above.

ROOM DIGEST (latest state):
<buildDigest(timeline, 12)>
```

The brief is sent as the first `prompt.submit` into the member session (marked
`[system] room brief` in the timeline). Every subsequent relayed message gets
the digest prepended:
```
<ROOM DIGEST> (latest) — from @<author>:
<message>
```

---

## 5. Message flow

### User posts (via composer)
1. Parse `@tags` from the input (`parseCoordination`).
2. If no tag → broadcast: append to timeline + digest, send to **all** members
   via `prompt.submit` (digest + "from @you: …").
3. If tagged → private relay to tagged member(s) + timeline entry + digest.
4. Clear composer; optimistically render the user message.

### Agent replies (via `assistant.completed`)
1. Look up member by `e.profile` (and `session_id`).
2. Parse `parseCoordination(e.content)`.
3. `[to @X]` → `prompt.submit` to X's session, digest + "from @member: text".
4. `[all]` / bare → timeline + digest append.
5. Render the member's message in the timeline (strip markers).

### Guard rails
- Relay loops: a `[to @X]` relay is never re-relayed even if X's reply also
  contains `[to @Y]` when both are true — actually it IS relayed (that's the
  swarm). But a message that is a verbatim echo of a previous relay is dropped.
- Rate: relays to a member are queued if that member is mid-turn
  (`queued: true` on prompt.submit) — the gateway's busy path holds them.
- Max digest length: last 12 messages, truncate long lines.

---

## 6. SDK surface used (exact)

```js
import { atom, useValue, host, Button, Input, Textarea, ScrollArea, Badge,
         StatusDot, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
         DropdownMenuTrigger, icons, cn, profileColor, profileColorSoft,
         PALETTE_AREA, haptic } from '@hermes/plugin-sdk'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'
```

All import names verified against `apps/desktop/src/sdk/index.ts` exports
(Badge, Button, DropdownMenu*, Input, PALETTE_AREA, ScrollArea, StatusDot,
Textarea, cn, haptic, host, icons, profileColor, profileColorSoft, atom,
useValue — all present).

---

## 7. Honest limits (do not overclaim)

1. **Awareness is protocol-based, not telepathic.** Agents know the roster and
   digest; they don't share live memory. Each think gets the current digest.
2. **Tool availability per profile is config, not runtime.** The browser toggle
   assigns the role + seeds the brief; the profile must have the browser
   toolset. Plugin toasts guidance when it can't verify.
3. **Parallel cognition costs what it costs.** Multi-profile sockets are
   native, but every profile is a real model run.
4. **Agent-initiated relays require the agent to follow the grammar.** If an
   agent ignores `[to @x]`, its output stays a broadcast. The brief + digest
   make compliance reliable, not guaranteed.

---

## 8. Verification plan

1. Node harness `test.cjs` — slice the pure functions out of plugin.js between
   marker comments, `new Function(...)`, assert parse/route/brief/digest
   contracts. (pattern: hermes-desktop-plugins skill §Verification.2)
2. Load check: plugin appears in pane within ~10s; `computer_use` capture to
   confirm no error toast.
3. Live smoke (user-run, needs a configured second profile): add profile →
   forge session → type `@default test` → confirm relay + reply in timeline.

---

## 9. QA pass (Aug 7, 2026)

### Bugs found and fixed
- **renderOptions stale-closure bug (critical, would crash):** `HiveRenderOptions`
  was a module-level function referencing `setOpen`/`setQ` — React state
  setters only in scope inside `AddMember`. Clicking any profile row in the
  Add-agent popover would throw `ReferenceError`. Fixed by passing callbacks as
  props.
- **Identifier collision risk (load-blocker):** The packaged app's runtime
  evaluates plugin blobs in a scope where generic top-level identifiers collide
  with bundle chunks — theme-forge died with `SyntaxError: Identifier
  'normalizeViewMode' has already been declared`. All top-level identifiers in
  buzz-hive are now `hive`-prefixed (154 occurrences). Confirmed clean: no load
  failures logged for buzz-hive; live sessions minted + briefs delivered at 01:36.

### Features added
- **Create-profile route:** "New profile…" row in the Add-agent popover opens an
  inline form (name, clone-from, optional SOUL). Mirrors the app's
  `CreateProfileDialog` (`POST /api/profiles {name, clone_from}`, optional
  `PUT /api/profiles/{name}/soul`). Name validation `/^[a-z0-9][a-z0-9_-]{0,63}$/`
  (same as app). New profile auto-joins the room.
- **You chip:** Pinned "You" member rendered at top of roster with `@you` label
  and StatusDot.
- **Room title rename:** click the title badge to edit inline.
- **Error states:** Add-agent popover shows "Couldn't load profiles" + Retry on
  fetch failure; empty state when all profiles are in the room.
- **Profile info in add list:** shows model + skill count per row.

### Live verification (logged)
- `~/.hermes/logs/agent.log` shows two live sessions minted by the plugin
  (default + audio-mixer) with room briefs delivered:
  `msg='[room digest] @system: @default joined the room  You are @audio-mixer, a member ...'`
  → full critical path (session.create → prompt.submit → brief → agent turn).
- 24 profiles exist on this machine (agency-*, closer, cofounder,
  frontier-savant*, …) — Add-agent list will be populated.
- No `runtime load failed (buzz-hive)` in any log = clean load.
- **Visual confirmation blocked** by broken vision backend (Gemini 404) — the
  one remaining item for TD's eyeball.

### Not testable without vision
Pane rendered appearance; toast appearance; @-autocomplete popover position.
