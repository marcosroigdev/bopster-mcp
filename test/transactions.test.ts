import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, getAddress, type Address } from 'viem'

import { erc20Abi, marketAbi } from '../src/chain/abis.js'
import type { TokenInfo } from '../src/chain/marketState.js'
import { positionTransactions } from '../src/tools/preparePosition.js'
import { GAS_LIMITS, marketCalls, parseAmount, signingInstructions, type GasAction } from '../src/tools/transactions.js'
import { ToolInputError } from '../src/tools/shared.js'

const MARKET: Address = getAddress('0x00000000000000000000000000000000000000aa')
const USDC: TokenInfo = { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC' }

describe('parseAmount', () => {
  it('reads whole token units, not base units', () => {
    assert.equal(parseAmount('5', USDC), 5_000_000n)
    assert.equal(parseAmount('2.5', USDC), 2_500_000n)
    assert.equal(parseAmount('0.000001', USDC), 1n)
  })

  it('refuses more precision than the token has', () => {
    assert.throws(() => parseAmount('0.0000001', USDC), ToolInputError)
  })

  it('refuses zero', () => {
    assert.throws(() => parseAmount('0.0', USDC), ToolInputError)
  })
})

describe('positionTransactions', () => {
  it('approves exactly the stake, then takes the position', () => {
    const txs = positionTransactions({ market: MARKET, token: USDC, side: 'YES', amount: 5_000_000n })

    assert.deepEqual(txs.map((t) => [t.step, t.action, t.to]), [
      [1, 'approve', USDC.address],
      [2, 'positionYes', MARKET],
    ])
    const approve = decodeFunctionData({ abi: erc20Abi, data: txs[0].data })
    assert.deepEqual(approve.args, [MARKET, 5_000_000n])
    const position = decodeFunctionData({ abi: marketAbi, data: txs[1].data })
    assert.equal(position.functionName, 'positionYes')
    assert.deepEqual(position.args, [5_000_000n])
  })

  // On Base Sepolia, YES then NO from one wallet came back as a lone positionNo: the allowance read
  // hit an RPC node that hadn't seen the YES position spend its approval, and positionNo reverted.
  it('approves every time, even with an allowance in place', () => {
    const txs = positionTransactions({ market: MARKET, token: USDC, side: 'NO', amount: 3_000_000n })

    assert.deepEqual(txs.map((t) => [t.step, t.action]), [
      [1, 'approve'],
      [2, 'positionNo'],
    ])
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: txs[0].data }).args, [MARKET, 3_000_000n])
  })

  it('never sends value', () => {
    const txs = positionTransactions({ market: MARKET, token: USDC, side: 'YES', amount: 1n })
    assert.ok(txs.every((t) => t.value === '0'))
  })

  it('gives the approve and the position their own gas limits', () => {
    const txs = positionTransactions({ market: MARKET, token: USDC, side: 'NO', amount: 3_000_000n })

    assert.deepEqual(txs.map((t) => [t.action, t.gas]), [
      ['approve', GAS_LIMITS.approve.toString()],
      ['positionNo', GAS_LIMITS.positionNo.toString()],
    ])
  })
})

describe('marketCalls', () => {
  it('encodes each settlement call against the market, in order', () => {
    const txs = marketCalls(MARKET, ['finalize', 'claim'])

    assert.deepEqual(
      txs.map((t) => [t.step, decodeFunctionData({ abi: marketAbi, data: t.data }).functionName, t.to]),
      [
        [1, 'finalize', MARKET],
        [2, 'claim', MARKET],
      ],
    )
  })

  it('sends each call with its own gas limit', () => {
    const txs = marketCalls(MARKET, ['lock', 'triggerEmergencyRefund', 'claimRefund'])

    assert.deepEqual(txs.map((t) => t.gas), [
      GAS_LIMITS.lock.toString(),
      GAS_LIMITS.triggerEmergencyRefund.toString(),
      GAS_LIMITS.claimRefund.toString(),
    ])
  })
})

describe('GAS_LIMITS', () => {
  // What each used, on Base Sepolia and on a fork of Base mainnet. A limit is what the wallet sends
  // instead of an estimate, so one below what the call needs makes it run out of gas: keep about
  // twice the measure as headroom.
  const MEASURED: Record<GasAction, bigint> = {
    approve: 55_437n, // a zero-to-nonzero allowance, the dearer write
    positionYes: 117_195n, // a wallet's first position on that side
    positionNo: 100_235n,
    lock: 49_760n,
    finalize: 198_272n, // paying out a win; settling a refund used less
    triggerEmergencyRefund: 88_337n,
    claim: 80_206n,
    claimRefund: 83_094n,
    askQuestion: 82_192n,
    createMarket: 1_401_745n,
  }

  for (const [action, used] of Object.entries(MEASURED)) {
    it(`leaves ${action} about twice what it used`, () => {
      assert.ok(GAS_LIMITS[action as GasAction] * 10n >= used * 19n)
    })
  }

  it('tells the agent to send with them instead of estimating', () => {
    assert.match(signingInstructions(null), /`gas` as the gas limit instead of estimating/)
  })
})
