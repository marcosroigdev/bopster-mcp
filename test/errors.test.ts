import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ContractFunctionRevertedError, HttpRequestError, RpcRequestError } from 'viem'

import { isRateLimited } from '../src/chain/client.js'
import { explainLoginFailure } from '../src/http/auth.js'
import { BackendHttpError, BackendUnavailableError } from '../src/http/client.js'
import { ToolInputError } from '../src/tools/shared.js'

describe('isRateLimited', () => {
  const rpc = (code: number, message: string) =>
    new RpcRequestError({ body: {}, error: { code, message }, url: 'https://rpc.example' })

  it("recognizes the public Base RPC's -32016 and the standard limit code", () => {
    assert.ok(isRateLimited(rpc(-32016, 'over rate limit')))
    assert.ok(isRateLimited(rpc(-32005, 'limit exceeded')))
  })

  it('recognizes an HTTP 429', () => {
    assert.ok(isRateLimited(new HttpRequestError({ status: 429, url: 'https://rpc.example' })))
  })

  it('does not mistake "429" inside revert data or an address for a rate limit', () => {
    assert.equal(isRateLimited(rpc(3, 'execution reverted: 0x00000000000000000000000000000000000429ab')), false)
    assert.equal(isRateLimited(new ContractFunctionRevertedError({ abi: [], functionName: 'claim', message: 'NothingToClaim 0x429' })), false)
  })
})

describe('explainLoginFailure', () => {
  const wallet = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

  it('reports a rate limit as a rate limit, not as a refused signature', () => {
    const explained = explainLoginFailure(new BackendHttpError(429, 'Backend error 429'), wallet)
    assert.ok(explained instanceof ToolInputError)
    assert.match((explained as Error).message, /rate-limiting/)
  })

  it('asks for a new signature when the backend refuses the login', () => {
    for (const status of [400, 401, 403, 422]) {
      const explained = explainLoginFailure(new BackendHttpError(status, `Backend error ${status}`), wallet)
      assert.match((explained as Error).message, /refused the login/, String(status))
    }
  })

  it('passes other failures through untouched', () => {
    const down = new BackendUnavailableError()
    assert.equal(explainLoginFailure(down, wallet), down)
    const odd = new BackendHttpError(409, 'Backend error 409')
    assert.equal(explainLoginFailure(odd, wallet), odd)
  })
})
