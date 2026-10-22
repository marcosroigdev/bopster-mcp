import {
  parseEventLogs,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem'

import { factoryAbi, realityAbi } from './abis.js'
import { chain, chainRead, publicClient, requireFactory } from './client.js'
import { multicall3Abi } from './marketState.js'
import { ToolInputError } from '../tools/shared.js'

/** What creating a market depends on right now: where questions go, whether the factory is open, and chain time. */
export async function readCreationState(): Promise<{ factory: Address; reality: Address; paused: boolean; now: bigint }> {
  const factory = requireFactory()
  const [reality, paused, now] = await chainRead(() =>
    publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: factory, abi: factoryAbi, functionName: 'reality' },
        { address: factory, abi: factoryAbi, functionName: 'paused' },
        { address: chain.contracts.multicall3.address, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
      ],
    }),
  )
  return { factory, reality, paused, now }
}

/** A confirmed, successful receipt, or an error telling the agent what to do about it. */
export async function readSuccessfulReceipt(hash: Hash): Promise<TransactionReceipt> {
  const receipt = await chainRead(async () => {
    try {
      return await publicClient.getTransactionReceipt({ hash })
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null
      throw error
    }
  })
  if (!receipt) {
    throw new ToolInputError(`No confirmed transaction ${hash} on ${chain.name} yet. Wait for it to confirm, then call again.`)
  }
  if (receipt.status !== 'success') throw new ToolInputError(`Transaction ${hash} reverted on-chain; nothing was created.`)
  return receipt
}

export type AskedQuestion = {
  questionId: Hex
  asker: Address
  templateId: bigint
  question: string
  arbitrator: Address
  timeout: number
  openingTs: number
}

/** The Reality.eth question a transaction asked, read from its LogNewQuestion. */
export function questionFromReceipt(receipt: TransactionReceipt, reality: Address): AskedQuestion | null {
  const logs = parseEventLogs({ abi: realityAbi, eventName: 'LogNewQuestion', logs: receipt.logs })
  const log = logs.find((l) => l.address.toLowerCase() === reality.toLowerCase())
  if (!log) return null
  return {
    questionId: log.args.question_id,
    asker: log.args.user,
    templateId: log.args.template_id,
    question: log.args.question,
    arbitrator: log.args.arbitrator,
    timeout: log.args.timeout,
    openingTs: log.args.opening_ts,
  }
}

/** The market a transaction created, read from the factory's MarketCreated. */
export function marketFromReceipt(receipt: TransactionReceipt, factory: Address) {
  const logs = parseEventLogs({ abi: factoryAbi, eventName: 'MarketCreated', logs: receipt.logs })
  const log = logs.find((l) => l.address.toLowerCase() === factory.toLowerCase())
  if (!log) return null
  return {
    market: log.args.market,
    creator: log.args.creator,
    questionId: log.args.questionId,
    endTime: log.args.endTime,
    resolveTime: log.args.resolveTime,
    blockNumber: receipt.blockNumber,
  }
}
