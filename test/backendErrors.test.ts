import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { explainLoginFailure, retryAfterSeconds } from '../src/http/auth.js'
import { explainPinFailure } from '../src/http/metadata.js'
import { BackendHttpError, BackendUnavailableError, getJson, getJsonWithMetadata } from '../src/http/client.js'
import { ToolInputError } from '../src/tools/shared.js'

const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/** An error as the backend sends it: `{ errors: [{ code, message, context }] }`, plus extras. */
function failure(status: number, errors: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return new BackendHttpError(status, `Backend error ${status}`, { errors, ...extra })
}

function message(error: unknown): string {
  assert.ok(error instanceof ToolInputError, `expected a ToolInputError, got ${String(error)}`)
  return error.message
}

describe('login failures, by the backend error code', () => {
  it('invalid_payload: names every field that came in malformed', () => {
    const text = message(
      explainLoginFailure(
        failure(400, [
          { code: 'invalid_payload', message: 'nonce must be the uuid returned by /auth/wallet/nonce', context: { field: 'nonce' } },
          { code: 'invalid_payload', message: 'signature property is mandatory', context: { field: 'signature' } },
        ]),
        WALLET,
      ),
    )
    assert.match(text, /malformed/)
    assert.match(text, /nonce: nonce must be the uuid/)
    assert.match(text, /signature: signature property is mandatory/)
  })

  it('nonce_not_found: asks for a message for this same wallet', () => {
    const text = message(explainLoginFailure(failure(401, [{ code: 'nonce_not_found', message: 'x' }]), WALLET))
    assert.match(text, /wasn't issued for/)
    assert.match(text, new RegExp(WALLET))
    assert.match(text, /get_login_message with this same wallet/)
  })

  it('nonce_expired_or_used: asks for a new message', () => {
    const text = message(explainLoginFailure(failure(401, [{ code: 'nonce_expired_or_used', message: 'x' }]), WALLET))
    assert.match(text, /expired or was already used/)
    assert.match(text, /each nonce works once/)
  })

  it('invalid_signature: says how to sign, and that undeployed smart wallets are not accepted yet', () => {
    const text = message(explainLoginFailure(failure(401, [{ code: 'invalid_signature', message: 'x' }]), WALLET))
    assert.match(text, /personal_sign \(EIP-191\)/)
    assert.match(text, /ERC-1271/)
    assert.match(text, /ERC-6492/)
  })

  it('rate_limit_exceeded: waits as long as the backend says', () => {
    const top = failure(429, [{ code: 'rate_limit_exceeded', message: 'Too many requests', context: { retry_after_seconds: 37 } }], {
      error: 'rate_limit_exceeded',
      retry_after_seconds: 37,
    })
    assert.match(message(explainLoginFailure(top, WALLET)), /Wait 37 seconds/)

    const onlyInContext = failure(429, [{ code: 'rate_limit_exceeded', context: { retry_after_seconds: 12 } }])
    assert.equal(retryAfterSeconds(onlyInContext), 12)
    assert.match(message(explainLoginFailure(onlyInContext, WALLET)), /Wait 12 seconds/)
  })

  it('falls back to the status when the backend sends no code', () => {
    assert.match(message(explainLoginFailure(new BackendHttpError(401, 'Backend error 401'), WALLET)), /refused the login \(HTTP 401\)/)
  })

  it('leaves outages alone', () => {
    const down = new BackendUnavailableError()
    assert.equal(explainLoginFailure(down, WALLET), down)
  })
})

describe('metadata pin failures', () => {
  it('template_param_invalid: names the field and the reason, and says it is template drift, not the agent', () => {
    const text = message(
      explainPinFailure(
        failure(422, [
          {
            code: 'template_param_invalid',
            message: 'asset must be 1 to 4 letters or digits',
            context: { field: 'templateParams.asset', reason: 'pattern', templateKey: 'price_threshold_v1' },
          },
        ]),
      ),
    )
    assert.match(text, /drifted from the backend's/)
    assert.match(text, /templateParams\.asset \(pattern\)/)
    assert.match(text, /won't help/)
    assert.match(text, /Nothing was created/)
  })

  it('template_question_mismatch: quotes the question the backend expected', () => {
    const expected = 'Will BTC be above $90000 at 2026-10-12 18:30 UTC?'
    const text = message(
      explainPinFailure(
        failure(422, [
          {
            code: 'template_question_mismatch',
            message: 'question must be exactly the text this template produces from templateParams',
            context: { field: 'question', reason: 'not_canonical', templateKey: 'price_threshold_v1', expected },
          },
        ]),
      ),
    )
    assert.ok(text.includes(`expects the question "${expected}"`))
  })

  it('template_unknown and template_params_invalid: are drift too', () => {
    for (const code of ['template_unknown', 'template_params_invalid']) {
      assert.match(message(explainPinFailure(failure(422, [{ code, message: 'x', context: { field: 'templateKey' } }]))), /drifted/, code)
    }
  })

  it('a pin rate limit says how long to wait', () => {
    assert.match(message(explainPinFailure(failure(429, [{ code: 'rate_limit_exceeded' }], { retry_after_seconds: 600 }))), /Wait 600 seconds/)
  })

  it('leaves other 422s and other failures as they were', () => {
    const other = failure(422, [{ code: 'something_else', message: 'x' }])
    assert.equal(explainPinFailure(other), other)
    const down = new BackendUnavailableError()
    assert.equal(explainPinFailure(down), down)
  })
})

describe('GET failures keep the backend body', () => {
  it('passes the parsed error body to BackendHttpError on GETs too', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ code: 'rate_limit_exceeded', context: { retry_after_seconds: 20 } }], retry_after_seconds: 20 }), {
        status: 429,
      })) as unknown as typeof fetch
    try {
      for (const read of [() => getJson('/auth/wallet/nonce'), () => getJsonWithMetadata('/markets')]) {
        await assert.rejects(read(), (error: unknown) => {
          assert.ok(error instanceof BackendHttpError)
          assert.equal(error.status, 429)
          assert.equal((error.body as { retry_after_seconds: number }).retry_after_seconds, 20)
          return true
        })
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
