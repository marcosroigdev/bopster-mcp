/**
 * Holds this server's templates to the contract the backend publishes on GET /market-templates
 * (test/fixtures/market-templates.v1.json, a real response). The backend only trusts a market whose
 * question is exactly what its template produces, so any drift between the two means markets made
 * here go up as low_trust. `pnpm check:templates` compares the fixture with a live backend.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DIRECTIONS,
  FORBIDDEN_EVENT_PREFIX,
  FORBIDDEN_EVENT_SUFFIX,
  FORBIDDEN_TEXT,
  MAX_PERCENTAGE,
  MAX_PRICE_LENGTH,
  PRICE_CURRENCY,
  PRICE_OPERATORS,
  TEXT_LIMITS,
  TICKER,
  renderTemplate,
  templateErrors,
  utcLabel,
  type TemplateInput,
} from '../src/planner/templates.js'

type Field = {
  name: string
  type: string
  pattern?: string
  min_length?: number
  max_length?: number
  values?: string[]
  renders_as?: Record<string, string>
  exclusive_minimum?: number
  maximum?: number | null
  max_rendered_length?: number | null
  length_unit?: string
  trimmed?: boolean
  forbidden_prefix?: { pattern: string; flags: string }
  forbidden_suffix?: string
  format?: string
}
type Template = { template_key: string; version: number; question_pattern: string; fields: Field[]; constraints: { rule: string; fields: string[]; compare: string }[] }
type Contract = {
  contract_version: number
  templates: Template[]
  rules: { deadline_label: { token: string; format: string }; text: { trim: string; length_unit: string; forbidden_characters: string } }
}

const contract = (JSON.parse(readFileSync(new URL('./fixtures/market-templates.v1.json', import.meta.url), 'utf8')) as { data: Contract }).data
const template = (key: string) => {
  const found = contract.templates.find((t) => t.template_key === key)
  assert.ok(found, `the contract has no ${key}`)
  return found
}
const field = (key: string, name: string) => {
  const found = template(key).fields.find((f) => f.name === name)
  assert.ok(found, `${key} has no field ${name}`)
  return found
}

/** The question the contract describes for these params: every token of the pattern replaced. */
function questionFromContract(key: string, params: Record<string, unknown>): string {
  const { question_pattern, fields } = template(key)
  let question = question_pattern
  for (const f of fields) {
    if (f.type === 'datetime') continue
    const raw = params[f.name]
    const text =
      f.type === 'enum' ? (f.renders_as ? f.renders_as[String(raw)] : String(raw)) : f.type === 'number' ? String(Number(raw)) : String(raw).trim()
    question = question.replaceAll(`{${f.name}}`, text)
  }
  const deadline = BigInt(Date.parse(String(params.deadlineUtc)) / 1000)
  question = question.replaceAll(contract.rules.deadline_label.token, utcLabel(deadline))
  assert.doesNotMatch(question, /\{\w+\}/, `a token of ${key} was left unreplaced`)
  return question
}

// 2026-10-12 18:30:00 UTC
const DEADLINE = BigInt(Date.UTC(2026, 9, 12, 18, 30) / 1000)

// The cases of test/templates.test.ts, plus decimals and text beyond ASCII.
const CASES: TemplateInput[] = [
  { type: 'price_threshold', asset: 'btc', direction: 'above', price: '90000' },
  { type: 'event_outcome', event: ' Real Madrid beat Barcelona ' },
  { type: 'before_date', subject: 'A spot Solana ETF', action: 'be approved by the SEC' },
  { type: 'price_change', asset: 'eth', direction: 'down', percentage: '10' },
  { type: 'compare_assets', asset_a: 'eth', direction: 'higher', asset_b: 'btc' },
  { type: 'price_threshold', asset: 'SOL', direction: 'below', price: '0.85' },
  { type: 'price_threshold', asset: 'ETH', direction: 'above', price: '3000.50' },
  { type: 'price_change', asset: 'BTC', direction: 'up', percentage: '2.50' },
  { type: 'event_outcome', event: 'Atlético de Madrid win La Liga 🏆' },
  { type: 'before_date', subject: 'La selección española', action: 'gane el Mundial de fútbol' },
  { type: 'compare_assets', asset_a: ' sol', direction: 'lower', asset_b: 'eth ' },
]

describe('the backend template contract', () => {
  it('is version 1, with the five templates this server builds', () => {
    assert.equal(contract.contract_version, 1)
    const built = new Set(CASES.map((input) => renderTemplate(input, DEADLINE).templateId))
    assert.deepEqual(new Set(contract.templates.map((t) => t.template_key)), built)
  })

  for (const input of CASES) {
    const rendered = renderTemplate(input, DEADLINE)
    const label = `${rendered.templateId} ${JSON.stringify(input)}`

    it(`words ${label} as the contract does, character for character`, () => {
      assert.equal(rendered.question, questionFromContract(rendered.templateId, rendered.templateParams))
    })

    it(`gives ${label} exactly the contract's params`, () => {
      const names = template(rendered.templateId).fields.map((f) => f.name)
      assert.deepEqual(Object.keys(rendered.templateParams).sort(), [...names].sort())
      assert.match(String(rendered.templateParams.deadlineUtc), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/)
      assert.equal(rendered.templateVersion, template(rendered.templateId).version)
    })
  }
})

describe('the limits, against the contract', () => {
  it('uses the same ticker rule for every asset field', () => {
    for (const [key, name] of [
      ['price_threshold_v1', 'asset'],
      ['price_change_v1', 'asset'],
      ['compare_assets_v1', 'assetA'],
      ['compare_assets_v1', 'assetB'],
    ] as const) {
      const f = field(key, name)
      assert.equal(f.pattern, TICKER.source, `${key}.${name}`)
      assert.equal(f.min_length, 1)
      assert.equal(f.max_length, 4)
    }
  })

  it('holds event, subject and action to the same lengths, counted the same way', () => {
    assert.equal(contract.rules.text.length_unit, 'utf16_code_units')
    assert.equal(contract.rules.text.trim, 'ecmascript_string_trim')
    for (const [key, name] of [
      ['event_outcome_v1', 'event'],
      ['before_date_v1', 'subject'],
      ['before_date_v1', 'action'],
    ] as const) {
      const f = field(key, name)
      assert.deepEqual({ min: f.min_length, max: f.max_length }, TEXT_LIMITS[name], `${key}.${name}`)
      assert.equal(f.length_unit, 'utf16_code_units')
      assert.equal(f.trimmed, true)
    }
    // An emoji is two UTF-16 code units, here as in the backend: 178 letters + 🏆 is 180, the max.
    assert.deepEqual(templateErrors({ type: 'event_outcome', event: `${'a'.repeat(178)}🏆` }), [])
    assert.equal(templateErrors({ type: 'event_outcome', event: `${'a'.repeat(179)}🏆` }).length, 1)
  })

  it("refuses the event's forbidden prefix and suffix, as the contract states them", () => {
    const f = field('event_outcome_v1', 'event')
    assert.equal(f.forbidden_prefix?.pattern, FORBIDDEN_EVENT_PREFIX.source)
    assert.equal(f.forbidden_prefix?.flags, FORBIDDEN_EVENT_PREFIX.flags)
    assert.equal(f.forbidden_suffix, FORBIDDEN_EVENT_SUFFIX)
  })

  it('caps the percentage at the same maximum, above zero', () => {
    const f = field('price_change_v1', 'percentage')
    assert.equal(f.maximum, MAX_PERCENTAGE)
    assert.equal(f.exclusive_minimum, 0)
    assert.ok(templateErrors({ type: 'price_change', asset: 'ETH', direction: 'up', percentage: '0' }).length > 0)
  })

  it('caps the written price at the same length, with no maximum value', () => {
    const f = field('price_threshold_v1', 'target')
    assert.equal(f.max_rendered_length, MAX_PRICE_LENGTH)
    assert.equal(f.maximum, null)
    assert.equal(f.exclusive_minimum, 0)
  })

  it('offers the same enum values, read the same way', () => {
    const operator = field('price_threshold_v1', 'operator')
    assert.deepEqual(operator.values, Object.values(PRICE_OPERATORS))
    assert.deepEqual(operator.renders_as, Object.fromEntries(Object.entries(PRICE_OPERATORS).map(([word, op]) => [op, word])))
    assert.deepEqual(field('price_threshold_v1', 'currency').values, [PRICE_CURRENCY])
    assert.deepEqual(field('price_change_v1', 'direction').values, [...DIRECTIONS.price_change])
    assert.deepEqual(field('compare_assets_v1', 'direction').values, [...DIRECTIONS.compare_assets])
  })

  it('refuses comparing an asset with itself, after trimming and uppercasing', () => {
    assert.deepEqual(template('compare_assets_v1').constraints, [
      { rule: 'different', fields: ['assetA', 'assetB'], compare: 'trimmed_uppercase' },
    ])
    assert.equal(templateErrors({ type: 'compare_assets', asset_a: ' eth', direction: 'higher', asset_b: 'ETH ' }).length, 1)
  })

  it('forbids exactly the same characters', () => {
    assert.equal(FORBIDDEN_TEXT.source, contract.rules.text.forbidden_characters)
    // And to the character, across every UTF-16 code unit.
    const theirs = new RegExp(contract.rules.text.forbidden_characters)
    for (let unit = 0; unit <= 0xffff; unit++) {
      const char = String.fromCharCode(unit)
      if (FORBIDDEN_TEXT.test(char) !== theirs.test(char)) assert.fail(`U+${unit.toString(16).padStart(4, '0')} is classified differently`)
    }
  })

  it('labels the deadline in the contract format', () => {
    assert.equal(contract.rules.deadline_label.format, 'YYYY-MM-DD HH:MM UTC')
    assert.match(utcLabel(DEADLINE), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/)
  })
})
