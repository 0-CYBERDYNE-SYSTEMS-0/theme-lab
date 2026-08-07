#!/usr/bin/env node
/**
 * Buzz-Hive logic harness. Slices the pure-function core out of plugin.js
 * (between the CORE markers) and asserts its contracts without loading the
 * Hermes desktop SDK. Run: node test.cjs
 */
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8')
const start = src.indexOf('// ── create-CORE-BEGIN')
const end = src.indexOf('// --CORE-END--')
if (start === -1 || end === -1) {
  console.error('FAIL: CORE markers not found in plugin.js')
  process.exit(1)
}
const core = src.slice(src.indexOf('\n', start) + 1, end)

// DIGEST_LEN is defined above the markers; inject it for the sliced scope.
const factory = new Function(
  `const DIGEST_LEN = 12;\n${core}\nreturn { parseCoordination, buildDigest, buildRoomBrief, routeUserPost, extractMentions, _normalize }`
)
const { parseCoordination, buildDigest, buildRoomBrief, routeUserPost, extractMentions, _normalize } = factory()

let pass = 0
let fail = 0
function assert(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`)
  }
}
function deep(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  assert(name, a === e, { actual: a, expected: e })
}

console.log('parseCoordination')
{
  const roster = ['builder', 'frontier', 'default']
  deep('bracket relay after-bracket', parseCoordination('[to @builder] sanity-check the CTA', roster), {
    relays: [{ target: 'builder', text: 'sanity-check the CTA', ask: false }],
    broadcast: ''
  })
  deep('ask short form inside brackets', parseCoordination('[ask @frontier: what is the price?]', roster), {
    relays: [{ target: 'frontier', text: 'what is the price?', ask: true }],
    broadcast: ''
  })
  deep('ask long form after bracket', parseCoordination('[ask @frontier] what is the price?', roster), {
    relays: [{ target: 'frontier', text: 'what is the price?', ask: true }],
    broadcast: ''
  })
  deep('broadcast all', parseCoordination('[all] heads up, room status changed', roster), {
    relays: [],
    broadcast: 'heads up, room status changed'
  })
  deep('multiple relays in one message', parseCoordination('[to @builder] check CTA [to @frontier] check pricing', roster), {
    relays: [
      { target: 'builder', text: 'check CTA', ask: false },
      { target: 'frontier', text: 'check pricing', ask: false }
    ],
    broadcast: ''
  })
  deep('unknown name stays broadcast', parseCoordination('[to @ghost] hi there', roster), {
    relays: [],
    broadcast: 'hi there'
  })
  deep('prose with no directives is broadcast', parseCoordination('just a normal message', roster), {
    relays: [],
    broadcast: 'just a normal message'
  })
  deep('relay + trailing prose', parseCoordination('[to @builder] do it. Also tell everyone.', roster), {
    relays: [{ target: 'builder', text: 'do it. Also tell everyone.', ask: false }],
    broadcast: ''
  })
  deep('bracket relay with ask before', parseCoordination('starting note [ask @frontier] price?', roster), {
    relays: [{ target: 'frontier', text: 'price?', ask: true }],
    broadcast: 'starting note'
  })
}

console.log('extractMentions')
{
  const roster = ['builder', 'frontier', 'default']
  deep('bare mention found', extractMentions('hey @builder check this', roster), ['builder'])
  deep('multiple bare mentions deduped', extractMentions('@builder and @builder and @frontier go', roster), ['builder', 'frontier'])
  deep('non-roster mention ignored', extractMentions('ping @ghost', roster), [])
  deep('mention inside word not matched', extractMentions('foo@builderbar', roster), [])
}

console.log('routeUserPost')
{
  const members = [{ profile: 'builder' }, { profile: 'frontier' }, { profile: 'default' }]
  deep('bare mention routes to member, mention stripped', routeUserPost('@builder check the email', members), {
    relays: [{ target: 'builder', text: 'check the email', ask: false }],
    broadcast: ''
  })
  deep('no mention broadcasts', routeUserPost('anyone home?', members), {
    relays: [],
    broadcast: 'anyone home?'
  })
  deep('bracket directive wins over bare mention', routeUserPost('[to @frontier] plan it. cc @builder', members), {
    relays: [{ target: 'frontier', text: 'plan it. cc @builder', ask: false }],
    broadcast: ''
  })
}

console.log('buildDigest')
{
  const tl = [
    { from: 'you', text: 'draft the email' },
    { from: 'frontier', text: 'done' },
    { from: 'builder', text: 'checked', to: 'frontier' }
  ]
  const d = buildDigest(tl, 12)
  assert('digest contains authors', d.includes('@you') && d.includes('@frontier') && d.includes('@builder'))
  assert('digest truncates long bodies', buildDigest([{ from: 'x', text: 'a'.repeat(500) }], 12).length < 250)
  deep('empty digest fallback', buildDigest([], 12), '(room is quiet)')
}

console.log('buildRoomBrief')
{
  const members = [{ profile: 'builder' }, { profile: 'default' }]
  const b = buildRoomBrief({ profile: 'builder' }, members, 'hive', false, [])
  assert('brief names the member', b.includes('@builder'))
  assert('brief lists roster incl. you', b.includes('@default') && b.includes('@you'))
  assert('brief teaches grammar', b.includes('[to @name]') && b.includes('[ask @name]') && b.includes('[all]'))
  assert('non-browser brief omits browser role', !b.includes('BROWSER AGENT'))
  const bb = buildRoomBrief({ profile: 'builder' }, members, 'hive', true, [])
  assert('browser brief includes browser role', bb.includes('BROWSER AGENT') && bb.includes('browser_navigate'))
}

console.log('\n' + (fail ? `FAIL ${fail}/${pass + fail}` : `ALL PASS ${pass}/${pass + fail}`))
process.exit(fail ? 1 : 0)
