# MISSION CONTRACT — Buzz-Hive

**Operator:** Hermes (TD's co-founder agent)
**Client:** TD
**Date:** 2026-08-07
**Contract type:** Autonomous build — bounded block, verify, deliver.

---

## 1. Mission statement

Build **Buzz-Hive**, a Buzz-like agent-collaboration room that runs natively
inside the Hermes desktop app as a plugin pane: up to 10 Hermes agent profiles
share one room with the user and the default agent; the user @-tags any member;
members coordinate with each other over a tag grammar relayed by the plugin.
Browser-control toggle assigns one member the browser role. Deliverable is a
**working, verified plugin**, not a description of one.

Buzz reference grounded from `engineering.block.xyz/blog/buzz` +
`github.com/block/buzz` (Block's open-source Nostr workspace, humans + agents
in shared rooms, agent-to-agent mentions).

## 2. What "done" means

- [ ] `~/.hermes/desktop-plugins/buzz-hive/plugin.js` exists, loads with no
      error toast, registers a right pane titled "hive".
- [ ] Pane shows: roster (You + default + up to 8 draggable profiles),
      room timeline, composer with @-autocomplete, per-member browser toggle,
      fresh-context button, persistence across restart.
- [ ] User `@name` posts route to that member's session (`prompt.submit`).
- [ ] `assistant.completed` events parse coordination tags and relay
      `[to @name]` to the named member's session; `[all]`/bare → room digest.
- [ ] Room brief + rolling digest keep every member aware of the roster,
      grammar, and current room state.
- [ ] Pure-function test harness passes (parser, router, brief, digest).
- [ ] Source grounded in `~/.hermes/hermes-agent` (SDK + gateway), DESIGN.md
      written, contract written, Telegram handoff message sent.

## 3. Non-negotiables (how I build)

1. **No guessing.** Every RPC, event, and SDK name in the plugin is verified
   against the local `hermes-agent` source or the plugin SDK.
2. **Honesty seams.** Protocol-based awareness, config-bound browser tools,
   real model cost for parallel profiles — surfaced, not hidden.
3. **One working artifact.** If the app can't run it, I say why and what's
   needed, with evidence.
4. **No external side effects without approval.** No repo publish, no posts.
   Local plugin install is internal and permitted by the mission.
5. **Git discipline** on the plugins dir — commit per iteration.

## 4. Constraints & boundaries

- Plugin is plain ESM, imports only `@hermes/plugin-sdk` / `react` /
  `react/jsx-runtime` (SDK runtime contract). UI via `jsx()` calls.
- Max 10 members incl. You + default.
- Single browser holder at a time (toggle semantics).
- No destructive actions: sessions are created and left in history; nothing is
  deleted. `session.close` only used by the app, never by this plugin.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Plugin load failure (SDK import/UI error) | Follow theme-forge conventions exactly; check pane via capture; fix-save hot-reloads. |
| `window.hermesDesktop.api` unavailable in plugin context | Fallback: let user type a profile name manually; resolve at session.create. |
| No configured second profile to smoke-test | Ship with harness-verified logic + You/default relay; document the live smoke test. |
| Relay loop (agent echoes tag to same agent) | Dedupe: drop verbatim re-relays of the last relayed text per member. |
| Profile mid-turn relay conflict | `queued: true` on prompt.submit; gateway holds it for next turn. |
| Packaged-app CSS classes dead | Use only base Tailwind classes + inline styles for layout-critical px. |

## 6. Verification evidence required

1. `node test.cjs` — all assertions green (printed).
2. `computer_use` capture of the Hermes pane showing "hive" + no error toast
   (or explicit report if vision is down, with event-based verification).
3. This contract + DESIGN.md + plugin.js all present.

## 7. Handoff

- Report in-chat with: what was built, what's verified, the honest seams,
  exact one-line install/use instructions, and a proposed Telegram message for
  TD.
- Telegram delivery attempted via available gateway; if no Telegram tool is
  wired in this session, the message is staged in `HANDOFF.md` and flagged.

---

Signed (operator): Hermes
Accepted (client): TD — by delegation, autonomous block.
