// Compares a live backend's GET /market-templates with test/fixtures/market-templates.v1.json, the
// contract test/templateContract.test.ts holds this server's templates to. Run it before deploying
// against a backend that may have changed its templates:
//
//   BOPSTER_API_URL=https://api.bopster.fun pnpm check:templates
//
// Exits 1 on any difference in the templates or rules. The `reality` block differs by network, so
// it's only compared with this server's BOPSTER_REALITY_* settings when they're set.
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

const apiUrl = (process.env.BOPSTER_API_URL || 'https://api.bopster.fun').replace(/\/$/, '')
const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/market-templates.v1.json', import.meta.url), 'utf8')).data

const response = await fetch(`${apiUrl}/market-templates`, { headers: { accept: 'application/json' } })
if (response.status === 404) {
  console.error(`${apiUrl} has no /market-templates yet: nothing to compare.`)
  process.exit(1)
}
if (!response.ok) {
  console.error(`${apiUrl}/market-templates answered ${response.status}.`)
  process.exit(1)
}
const live = (await response.json()).data

const differences = []
if (live.contract_version !== fixture.contract_version) {
  differences.push(`contract_version: fixture ${fixture.contract_version}, backend ${live.contract_version}`)
}
const keys = (list) => list.map((t) => t.template_key)
for (const key of new Set([...keys(fixture.templates), ...keys(live.templates)])) {
  const ours = fixture.templates.find((t) => t.template_key === key)
  const theirs = live.templates.find((t) => t.template_key === key)
  if (!ours || !theirs) {
    differences.push(`${key}: only in the ${ours ? 'fixture' : 'backend'}`)
    continue
  }
  for (const part of ['version', 'question_pattern', 'constraints']) {
    if (!isDeepStrictEqual(ours[part], theirs[part])) differences.push(`${key}.${part} differs`)
  }
  for (const name of new Set([...ours.fields, ...theirs.fields].map((f) => f.name))) {
    const a = ours.fields.find((f) => f.name === name)
    const b = theirs.fields.find((f) => f.name === name)
    if (!isDeepStrictEqual(a, b)) differences.push(`${key}.fields.${name}: fixture ${JSON.stringify(a)}, backend ${JSON.stringify(b)}`)
  }
}
for (const rule of new Set([...Object.keys(fixture.rules), ...Object.keys(live.rules)])) {
  if (!isDeepStrictEqual(fixture.rules[rule], live.rules[rule])) differences.push(`rules.${rule} differs`)
}

const settings = []
const arbitrator = process.env.BOPSTER_REALITY_ARBITRATOR
const timeout = process.env.BOPSTER_REALITY_TIMEOUT_SECONDS
console.log(`${apiUrl} expects Reality questions with template ${live.reality.template_id}, arbitrator ${live.reality.arbitrator}, timeout ${live.reality.timeout}s.`)
if (arbitrator && arbitrator.toLowerCase() !== String(live.reality.arbitrator).toLowerCase()) {
  settings.push(`BOPSTER_REALITY_ARBITRATOR is ${arbitrator}, backend expects ${live.reality.arbitrator}`)
}
if (timeout && Number(timeout) !== live.reality.timeout) {
  settings.push(`BOPSTER_REALITY_TIMEOUT_SECONDS is ${timeout}, backend expects ${live.reality.timeout}`)
}

if (differences.length > 0) {
  console.error(`\n${differences.length} difference(s) between the fixture and ${apiUrl}:\n- ${differences.join('\n- ')}`)
  console.error('Update src/planner/templates.ts and the fixture together, then run pnpm test.')
} else {
  console.log(`The templates and rules match the fixture (contract v${live.contract_version}).`)
}
if (settings.length > 0) {
  console.error(`\nThis server's Reality settings don't match ${apiUrl}; markets it created would be low_trust:\n- ${settings.join('\n- ')}`)
}
process.exit(differences.length + settings.length > 0 ? 1 : 0)
