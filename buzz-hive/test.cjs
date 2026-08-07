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

// HIVE_DIGEST_LEN is defined above the markers; inject it for the sliced scope.
const factory = new Function(
  `const HIVE_DIGEST_LEN = 12;\nconst HIVE_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;\n${core}\nreturn { hiveParseCoordination, hiveBuildDigest, hiveBuildRoomBrief, hiveRouteUserPost, hiveExtractMentions, hiveNormalize, hiveIsValidProfileName }`
)
const {
  hiveParseCoordination,
  hiveBuildDigest,
  hiveBuildRoomBrief,
  hiveRouteUserPost,
  hiveExtractMentions,
  hiveNormalize,
  hiveIsValidProfileName
} = factory()

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

console.log('hiveParseCoordination')
{
  const roster = ['builder', 'frontier', 'default']
  deep('bracket relay after-bracket', hiveParseCoordination('[to @builder] sanity-check the CTA', roster), {
    relays: [{ target: 'builder', text: 'sanity-check the CTA', ask: false }],
    broadcast: ''
  })
  deep('ask short form inside brackets', hiveParseCoordination('[ask @frontier: what is the price?]', roster), {
    relays: [{ target: 'frontier', text: 'what is the price?', ask: true }],
    broadcast: ''
  })
  deep('ask long form after bracket', hiveParseCoordination('[ask @frontier] what is the price?', roster), {
    relays: [{ target: 'frontier', text: 'what is the price?', ask: true }],
    broadcast: ''
  })
  deep('broadcast all', hiveParseCoordination('[all] heads up, room status changed', roster), {
    relays: [],
    broadcast: 'heads up, room status changed'
  })
  deep('multiple relays in one message', hiveParseCoordination('[to @builder] check CTA [to @frontier] check pricing', roster), {
    relays: [
      { target: 'builder', text: 'check CTA', ask: false },
      { target: 'frontier', text: 'check pricing', ask: false }
    ],
    broadcast: ''
  })
  deep('unknown name stays broadcast', hiveParseCoordination('[to @ghost] hi there', roster), {
    relays: [],
    broadcast: 'hi there'
  })
  deep('prose with no directives is broadcast', hiveParseCoordination('just a normal message', roster), {
    relays: [],
    broadcast: 'just a normal message'
  })
  deep('relay + trailing prose', hiveParseCoordination('[to @builder] do it. Also tell everyone.', roster), {
    relays: [{ target: 'builder', text: 'do it. Also tell everyone.', ask: false }],
    broadcast: ''
  })
  deep('bracket relay with ask before', hiveParseCoordination('starting note [ask @frontier] price?', roster), {
    relays: [{ target: 'frontier', text: 'price?', ask: true }],
    broadcast: 'starting note'
  })
}

console.log('hiveExtractMentions')
{
  const roster = ['builder', 'frontier', 'default']
  deep('bare mention found', hiveExtractMentions('hey @builder check this', roster), ['builder'])
  deep('multiple bare mentions deduped', hiveExtractMentions('@builder and @builder and @frontier go', roster), ['builder', 'frontier'])
  deep('non-roster mention ignored', hiveExtractMentions('ping @ghost', roster), [])
  deep('mention inside word not matched', hiveExtractMentions('foo@builderbar', roster), [])
  deep('mention at start', hiveExtractMentions('@builder go now', roster), ['builder'])
}

console.log('hiveRouteUserPost')
{
  const members = [{ profile: 'builder' }, { profile: 'frontier' }, { profile: 'default' }]
  deep('bare mention routes to member, mention stripped', hiveRouteUserPost('@builder check the email', members), {
    relays: [{ target: 'builder', text: 'check the email', ask: false }],
    broadcast: ''
  })
  deep('no mention broadcasts', hiveRouteUserPost('anyone home?', members), {
    relays: [],
    broadcast: 'anyone home?'
  })
  deep('bracket directive wins over bare mention', hiveRouteUserPost('[to @frontier] plan it. cc @builder', members), {
    relays: [{ target: 'frontier', text: 'plan it. cc @builder', ask: false }],
    broadcast: ''
  })
}

console.log('hiveBuildDigest')
{
  const tl = [
    { from: 'you', text: 'draft the email' },
    { from: 'frontier', text: 'done' },
    { from: 'builder', text: 'checked', to: 'frontier' }
  ]
  const d = hiveBuildDigest(tl, 12)
  assert('digest contains authors', d.includes('@you') && d.includes('@frontier') && d.includes('@builder'))
  assert('digest truncates long bodies', hiveBuildDigest([{ from: 'x', text: 'a'.repeat(500) }], 12).length < 250)
  deep('empty digest fallback', hiveBuildDigest([], 12), '(room is quiet)')
}

console.log('hiveBuildRoomBrief')
{
  const members = [{ profile: 'builder' }, { profile: 'default' }]
  const b = hiveBuildRoomBrief({ profile: 'builder' }, members, 'hive', false, [])
  assert('brief names the member', b.includes('@builder'))
  assert('brief lists roster incl. you', b.includes('@default') && b.includes('@you'))
  assert('brief teaches grammar', b.includes('[to @name]') && b.includes('[ask @name]') && b.includes('[all]'))
  assert('non-browser brief omits browser role', !b.includes('BROWSER AGENT'))
  const bb = hiveBuildRoomBrief({ profile: 'builder' }, members, 'hive', true, [])
  assert('browser brief includes browser role', bb.includes('BROWSER AGENT') && bb.includes('browser_navigate'))
}

console.log('hiveNormalize + name validation')
{
  deep('normalize empty → default', hiveNormalize(''), 'default')
  deep('normalize trims + lower', hiveNormalize('  Builder '), 'builder')
  assert('valid name ok', hiveIsValidProfileName('builder-2_x'))
  assert('reject uppercase', !hiveIsValidProfileName('Builder'))
  assert('reject leading digit ok (allowed)', hiveIsValidProfileName('2build'))
  assert('reject space', !hiveIsValidProfileName('my profile'))
  assert('reject empty', !hiveIsValidProfileName(''))
  assert('reject >64 chars', !hiveIsValidProfileName('a'.repeat(70)))
  assert('reject leading dash', !hiveIsValidProfileName('-builder'))
}

console.log('\n' + (fail ? `FAIL ${fail}/${pass + fail}` : `ALL PASS ${pass}/${pass + fail}`))
process.exit(fail ? 1 : 0)
