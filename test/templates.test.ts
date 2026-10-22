import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { renderTemplate, templateErrors, utcLabel, type TemplateInput } from '../src/planner/templates.js'

// 2026-10-12 18:30:00 UTC
const DEADLINE = BigInt(Date.UTC(2026, 9, 12, 18, 30) / 1000)
const DEADLINE_ISO = '2026-10-12T18:30:00.000Z'

describe('utcLabel', () => {
  it('formats the deadline the way the site does', () => {
    assert.equal(utcLabel(DEADLINE), '2026-10-12 18:30 UTC')
  })
})

describe('renderTemplate', () => {
  // Each expected question is CreatePage.vue's renderQuestion() for the same fields.
  const cases: [TemplateInput, string][] = [
    [
      { type: 'price_threshold', asset: 'btc', direction: 'above', price: '90000' },
      'Will BTC be above $90000 at 2026-10-12 18:30 UTC?',
    ],
    [
      { type: 'event_outcome', event: ' Real Madrid beat Barcelona ' },
      'Will Real Madrid beat Barcelona before 2026-10-12 18:30 UTC?',
    ],
    [
      { type: 'before_date', subject: 'A spot Solana ETF', action: 'be approved by the SEC' },
      'Will A spot Solana ETF be approved by the SEC before 2026-10-12 18:30 UTC?',
    ],
    [
      { type: 'price_change', asset: 'eth', direction: 'down', percentage: '10' },
      'Will ETH go down by 10% from its market creation before 2026-10-12 18:30 UTC?',
    ],
    [
      { type: 'compare_assets', asset_a: 'eth', direction: 'higher', asset_b: 'btc' },
      'Will ETH be higher than BTC at 2026-10-12 18:30 UTC?',
    ],
  ]

  for (const [input, question] of cases) {
    it(`words ${input.type} exactly like the site`, () => {
      assert.equal(renderTemplate(input, DEADLINE).question, question)
    })

    // Which params, and their exact names, is test/templateContract.test.ts's job, against the
    // backend's published contract.
    it(`dates ${input.type} at the deadline, as template version 1`, () => {
      const rendered = renderTemplate(input, DEADLINE)
      assert.equal(rendered.templateParams.deadlineUtc, DEADLINE_ISO)
      assert.equal(rendered.templateVersion, 1)
    })
  }

  it('writes numbers the way the form number inputs hand them over', () => {
    // type="number" inputs reach the question as numbers: "90000.0" → 90000, "2.50" → 2.5.
    assert.equal(
      renderTemplate({ type: 'price_threshold', asset: 'BTC', direction: 'below', price: '90000.0' }, DEADLINE).question,
      'Will BTC be below $90000 at 2026-10-12 18:30 UTC?',
    )
    assert.match(renderTemplate({ type: 'price_change', asset: 'SOL', direction: 'up', percentage: '2.50' }, DEADLINE).question, /by 2\.5%/)
  })

  it('stores the price threshold as the site does', () => {
    const { templateParams } = renderTemplate({ type: 'price_threshold', asset: 'eth', direction: 'below', price: '3000' }, DEADLINE)
    assert.deepEqual(templateParams, { asset: 'ETH', operator: '<=', target: 3000, currency: 'USD', deadlineUtc: DEADLINE_ISO })
  })
})

describe('templateErrors', () => {
  it('passes sound fields', () => {
    assert.deepEqual(templateErrors({ type: 'event_outcome', event: 'Real Madrid beat Barcelona' }), [])
  })

  it('holds tickers to the form limit of 4 characters', () => {
    assert.equal(templateErrors({ type: 'price_threshold', asset: 'DOGEX', direction: 'above', price: '1' }).length, 1)
  })

  it('refuses an event that repeats what the template adds', () => {
    assert.ok(templateErrors({ type: 'event_outcome', event: 'Will Spain win the cup' }).some((e) => /Will/.test(e)))
    assert.ok(templateErrors({ type: 'event_outcome', event: 'Spain win the cup?' }).some((e) => /\?/.test(e)))
  })

  it('holds events, subjects and actions to the form lengths', () => {
    assert.equal(templateErrors({ type: 'event_outcome', event: 'Rain' }).length, 1)
    assert.equal(templateErrors({ type: 'before_date', subject: 'ETF', action: 'be approved' }).length, 1)
  })

  it('refuses a price that is not a positive number', () => {
    assert.equal(templateErrors({ type: 'price_threshold', asset: 'BTC', direction: 'above', price: '90,000' }).length, 1)
    assert.equal(templateErrors({ type: 'price_threshold', asset: 'BTC', direction: 'above', price: '0' }).length, 1)
  })

  it('keeps a price change between 0 and 100 percent', () => {
    assert.equal(templateErrors({ type: 'price_change', asset: 'ETH', direction: 'up', percentage: '150' }).length, 1)
    assert.equal(templateErrors({ type: 'price_change', asset: 'ETH', direction: 'up', percentage: '0' }).length, 1)
  })

  it('refuses comparing an asset with itself', () => {
    assert.equal(templateErrors({ type: 'compare_assets', asset_a: 'eth', direction: 'higher', asset_b: 'ETH' }).length, 1)
  })
})

describe('templateErrors on text the site could never send', () => {
  it('refuses line breaks and control characters', () => {
    assert.ok(templateErrors({ type: 'event_outcome', event: 'Spain win\nthe cup final' }).some((e) => /single line/.test(e)))
    assert.ok(templateErrors({ type: 'before_date', subject: 'A spot SOL ETF\t', action: 'be approved by the SEC' }).some((e) => /single line/.test(e)))
  })

  it("refuses Reality.eth's field separator, which would split the oracle's question", () => {
    assert.ok(templateErrors({ type: 'event_outcome', event: 'Spain win the cup␟sports␟en' }).some((e) => /single line/.test(e)))
  })

  it('refuses numbers that would print in exponent notation', () => {
    assert.ok(templateErrors({ type: 'price_threshold', asset: 'BTC', direction: 'above', price: '0.0000001' }).some((e) => /plain digits/.test(e)))
    assert.ok(templateErrors({ type: 'price_threshold', asset: 'BTC', direction: 'above', price: '1000000000000000000000' }).some((e) => /plain digits/.test(e)))
    assert.ok(templateErrors({ type: 'price_change', asset: 'ETH', direction: 'up', percentage: '0.0000001' }).some((e) => /plain digits/.test(e)))
    assert.deepEqual(templateErrors({ type: 'price_threshold', asset: 'BTC', direction: 'above', price: '0.000001' }), [])
  })
})
