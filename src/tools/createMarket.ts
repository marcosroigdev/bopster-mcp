import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { encodeFunctionData, getAddress, type Hash } from 'viem'

import { config } from '../config.js'
import { factoryAbi, realityAbi } from '../chain/abis.js'
import { chain } from '../chain/client.js'
import { marketFromReceipt, questionFromReceipt, readCreationState, readSuccessfulReceipt } from '../chain/creation.js'
import { marketForQuestion } from '../chain/registry.js'
import { getLoginNonce, openSession, readProfileAlias } from '../http/auth.js'
import { BackendHttpError, BackendUnavailableError, sendJson } from '../http/client.js'
import {
  creatorNameError,
  DEFAULT_RESOLUTION_DELAY_MINUTES,
  launchTimingError,
  loginMessage,
  MARKET_CATEGORIES,
  RESOLUTION_DELAY_MINUTES,
  validateDraft,
} from '../planner/creation.js'
import { sportsMatchInput, templateInput } from '../planner/templates.js'
import { checkRealityAgainstBackend } from '../http/marketTemplates.js'
import { pinMetadata } from '../http/metadata.js'
import { isSignedDraft, signDraft } from './draftToken.js'
import { clientKey, LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE, takeLoginMessage } from './loginLimit.js'
import { gasFor, signingInstructions, time, walletInput, type UnsignedTransaction } from './transactions.js'
import { jsonResult, runTool, ToolInputError } from './shared.js'

/**
 * Creating a market takes four calls, the same steps the site walks a person through:
 *
 *   get_login_message → (wallet signs) → prepare_market_question → (wallet sends) →
 *   prepare_market_launch → (wallet sends) → register_market
 *
 * Each step hands back the exact arguments for the next. Nothing is signed or sent here.
 */

const REALITY_BOOL_TEMPLATE = 0n

/** This server's Reality.eth settings, in the shape the backend's /market-templates uses. */
function ourReality(arbitrator: string) {
  return { templateId: Number(REALITY_BOOL_TEMPLATE), arbitrator, timeoutSeconds: config.reality.timeoutSeconds }
}

const NEXT_STEP = 'Once it confirms, call `next.tool` with `next.arguments`, filling in its transaction hash.'

const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a 0x-prefixed 32-byte transaction hash.')

function requireArbitrator() {
  if (!config.reality.arbitrator) {
    throw new ToolInputError('Market creation is off on this server: no Reality.eth arbitrator is configured (BOPSTER_REALITY_ARBITRATOR).')
  }
  return getAddress(config.reality.arbitrator)
}

async function requireOpenFactory() {
  const state = await readCreationState()
  if (state.paused) throw new ToolInputError('Market creation is paused on the Bopster factory right now. Existing markets are unaffected.')
  return state
}

export function registerGetLoginMessage(server: McpServer): void {
  server.registerTool(
    'get_login_message',
    {
      title: 'Get a Bopster login message',
      description:
        'Step 1 of creating a Bopster market, and what get_portfolio needs. Returns a one-time message for the wallet ' +
        'to sign with personal_sign (EIP-191). The signature opens a short session with the Bopster backend, used ' +
        "only for the one request that needs it: pinning a new market's metadata to IPFS, or reading this wallet's " +
        "own portfolio. It can't move funds or sign transactions. Each client gets " +
        `${LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE} a minute: ask for one only when you're about to sign it.`,
      inputSchema: { wallet: walletInput },
    },
    async (args, extra) =>
      runTool(async () => {
        const verdict = takeLoginMessage(clientKey(extra.requestInfo?.headers))
        if (!verdict.allowed) {
          throw new ToolInputError(
            `This client asked for ${LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE} login messages in the last minute. ` +
              `Wait ${verdict.retryAfterSeconds} seconds, then call get_login_message again. Each message works once, ` +
              'so ask for one only when the wallet is about to sign it.',
          )
        }
        const wallet = getAddress(args.wallet)
        const { nonce, expiresAt } = await getLoginNonce(wallet)
        return jsonResult({
          wallet,
          nonce,
          message: loginMessage(wallet, nonce),
          expiresAt,
          next:
            'Sign `message` exactly as given, with personal_sign from this wallet, then call prepare_market_question ' +
            "(to create a market) or get_portfolio (to read this wallet's portfolio) with wallet, nonce and the signature.",
        })
      }),
  )
}

export function registerPrepareMarketQuestion(server: McpServer): void {
  server.registerTool(
    'prepare_market_question',
    {
      title: 'Prepare a Bopster market question',
      description:
        'Step 2 of creating a Bopster market. The question is built from one of the five Bopster templates (price ' +
        'threshold, event outcome, before a date, price change, compare assets), worded exactly as bopster.fun words ' +
        'it; free-text questions are not accepted. Checks the market against every rule the site, the backend and ' +
        'the factory enforce, pins its metadata to IPFS, and returns the unsigned Reality.eth askQuestion ' +
        'transaction. Non-custodial: nothing is signed or sent here.',
      inputSchema: {
        wallet: walletInput,
        nonce: z.string().min(1).describe('The nonce from get_login_message.'),
        signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'A 0x-prefixed hex signature.').describe('The personal_sign signature of the login message.'),
        title: z.string().describe('Short title shown on the market card, e.g. "BTC above $90K on Oct 12".'),
        template: templateInput,
        category: z.string().describe(`One of ${MARKET_CATEGORIES.join(', ')} (others are accepted, but can't be filtered for).`),
        source_url: z.string().describe('The public page that will settle the answer.'),
        end_time: z
          .string()
          .describe(
            'When positions close: ISO 8601 with a timezone, on a whole minute, e.g. "2026-10-12T18:00:00Z". 20 minutes ' +
              'to 10 days from now. For a match, the kick-off.',
          ),
        resolution_delay_minutes: z
          .number()
          .int()
          .optional()
          .describe(
            `How long after close the oracle may answer: long enough for the result to exist. One of ${RESOLUTION_DELAY_MINUTES.join(', ')}; ` +
              `default ${DEFAULT_RESOLUTION_DELAY_MINUTES}. The question names close plus this delay as its deadline. ` +
              'Set by the sport for a match.',
          ),
        sports_match: sportsMatchInput.optional(),
        creator_name: z
          .string()
          .optional()
          .describe('Display name for wallets without a Bopster profile. Ignored when the wallet has one: its alias is used.'),
        accept_terms: z
          .literal(true)
          .describe("Creating a market accepts Bopster Fun's Terms and Conditions of Use, the same as on bopster.fun/create."),
      },
    },
    async (args) =>
      runTool(async () => {
        const wallet = getAddress(args.wallet)
        const arbitrator = requireArbitrator()
        const state = await requireOpenFactory()
        // Before validating, signing in or pinning: a question the backend wouldn't trust isn't
        // worth a login, a pin or a transaction.
        await checkRealityAgainstBackend(ourReality(arbitrator))

        const { errors, draft } = validateDraft(
          {
            title: args.title,
            template: args.template,
            category: args.category,
            sourceUrl: args.source_url,
            endTime: args.end_time,
            resolutionDelayMinutes: args.resolution_delay_minutes,
            sportsMatch: args.sports_match,
          },
          state.now,
        )
        if (!draft) throw new ToolInputError(`The market can't be created as asked:\n- ${errors.join('\n- ')}`)

        const alias = await readProfileAlias(wallet)
        let creator = alias
        if (!creator) {
          if (!args.creator_name) {
            throw new ToolInputError('This wallet has no Bopster profile yet. Pass creator_name, or set up a profile at bopster.fun/my-profile.')
          }
          const nameError = creatorNameError(args.creator_name)
          if (nameError) throw new ToolInputError(nameError)
          creator = args.creator_name.trim()
        }

        // Signature checks and pins happen last, so a bad draft never spends the nonce.
        const session = await openSession(wallet, args.nonce, args.signature)
        const metadataUri = await pinMetadata(
          {
            title: draft.title,
            category: draft.category,
            creator,
            question: draft.question,
            wallet,
            questionType: 'template',
            templateId: draft.templateId,
            templateVersion: draft.templateVersion,
            templateParams: draft.templateParams,
            sourceUrl: draft.sourceUrl,
            language: 'en',
            network: config.chainId === 84532 ? 'base-sepolia' : 'base',
            createdAt: new Date().toISOString(),
          },
          session,
        )

        const ask: UnsignedTransaction = {
          step: 1,
          action: 'askQuestion',
          description: 'Ask the YES/NO question on Reality.eth, the oracle that will settle the market.',
          to: state.reality,
          data: encodeFunctionData({
            abi: realityAbi,
            functionName: 'askQuestion',
            // Opening at the resolve time: before it, Reality refuses answers, so nobody can settle
            // the question before the outcome exists.
            args: [
              REALITY_BOOL_TEMPLATE,
              draft.question,
              arbitrator,
              config.reality.timeoutSeconds,
              Number(draft.resolveTime),
              BigInt(Date.now()),
            ],
          }),
          value: config.reality.answerRewardWei.toString(),
          gas: gasFor('askQuestion'),
        }

        return jsonResult({
          wallet,
          creator,
          title: draft.title,
          template: draft.templateId,
          question: draft.question,
          category: draft.category,
          sourceUrl: draft.sourceUrl,
          closesAt: time(draft.endTime),
          resolvesAt: time(draft.resolveTime),
          metadataUri,
          transactions: [ask],
          warnings: draft.warnings,
          instructions: signingInstructions(wallet, NEXT_STEP),
          next: {
            tool: 'prepare_market_launch',
            arguments: {
              wallet,
              question_tx_hash: '<hash of the askQuestion transaction once confirmed>',
              metadata_uri: metadataUri,
              question: draft.question,
              end_time: Number(draft.endTime),
              resolve_time: Number(draft.resolveTime),
              draft_token: signDraft({ wallet, metadataUri, question: draft.question, endTime: draft.endTime, resolveTime: draft.resolveTime }),
            },
          },
        })
      }),
  )
}

export function registerPrepareMarketLaunch(server: McpServer): void {
  server.registerTool(
    'prepare_market_launch',
    {
      title: 'Prepare a Bopster market launch',
      description:
        'Step 3 of creating a Bopster market. Only launches drafts prepare_market_question built: pass its ' +
        '`next.arguments` unchanged, plus the question tx hash. Reads the confirmed askQuestion transaction, checks ' +
        'it is exactly the drafted question (same text, asker, arbitrator, answer window and opening time), and ' +
        'returns the unsigned createMarket transaction. Non-custodial: nothing is signed or sent here.',
      inputSchema: {
        wallet: walletInput,
        question_tx_hash: txHashSchema.describe('Hash of the confirmed askQuestion transaction.'),
        metadata_uri: z.string().regex(/^ipfs:\/\/\S+$/, 'An ipfs:// URI from prepare_market_question.'),
        question: z.string().describe('The question text, from prepare_market_question.'),
        end_time: z.number().int().positive().describe('Unix seconds, from prepare_market_question.'),
        resolve_time: z.number().int().positive().describe('Unix seconds, from prepare_market_question.'),
        draft_token: z.string().min(1).describe('From prepare_market_question. Proves this server drafted the market.'),
      },
    },
    async (args) =>
      runTool(async () => {
        const wallet = getAddress(args.wallet)
        const arbitrator = requireArbitrator()
        const end = BigInt(args.end_time)
        const resolve = BigInt(args.resolve_time)
        const drafted = { wallet, metadataUri: args.metadata_uri, question: args.question, endTime: end, resolveTime: resolve }
        if (!isSignedDraft(drafted, args.draft_token)) {
          throw new ToolInputError(
            'This server only launches markets prepare_market_question drafted from a template, and these arguments ' +
              "don't match one (or the server restarted since). Run prepare_market_question again.",
          )
        }

        const state = await requireOpenFactory()
        const recheck = await checkRealityAgainstBackend(ourReality(arbitrator), { optional: true })

        const receipt = await readSuccessfulReceipt(args.question_tx_hash as Hash)
        const asked = questionFromReceipt(receipt, state.reality)
        if (!asked) throw new ToolInputError(`Transaction ${args.question_tx_hash} asked no question on the Bopster Reality.eth contract.`)

        const problems: string[] = []
        if (asked.question !== args.question) problems.push('its text is not the drafted question')
        if (asked.asker.toLowerCase() !== wallet.toLowerCase()) problems.push(`it was asked by ${asked.asker}, not ${wallet}`)
        if (asked.templateId !== REALITY_BOOL_TEMPLATE) problems.push('it is not a YES/NO question')
        if (asked.arbitrator.toLowerCase() !== arbitrator.toLowerCase()) problems.push(`its arbitrator is ${asked.arbitrator}, not Bopster's ${arbitrator}`)
        if (asked.timeout !== config.reality.timeoutSeconds) problems.push(`its answer window is ${asked.timeout}s, not ${config.reality.timeoutSeconds}s`)
        if (asked.openingTs !== args.resolve_time) {
          problems.push(`it opens for answers at ${asked.openingTs}, but resolve_time is ${args.resolve_time}; they must match`)
        }
        if (problems.length > 0) {
          throw new ToolInputError(`That question doesn't fit this market: ${problems.join('; ')}. Start again from prepare_market_question.`)
        }

        // A signed draft stays valid, so a retry could otherwise deploy a second market on the same
        // question and split its positions in two.
        const existing = await marketForQuestion(asked.questionId)
        if (existing) {
          throw new ToolInputError(
            `This question already has a market: ${existing} (${config.siteUrl}/markets/${existing}). ` +
              "Don't launch it twice. If you haven't yet, call register_market with the createMarket transaction that made it.",
          )
        }

        const timing = launchTimingError(end, resolve, state.now)
        if (timing) throw new ToolInputError(timing)

        const launch: UnsignedTransaction = {
          step: 1,
          action: 'createMarket',
          description: 'Deploy the market on the Bopster factory. The sending wallet becomes its creator and earns the creator fee.',
          to: state.factory,
          data: encodeFunctionData({
            abi: factoryAbi,
            functionName: 'createMarket',
            args: [asked.questionId, args.metadata_uri, end, resolve],
          }),
          value: '0',
          gas: gasFor('createMarket'),
        }

        return jsonResult({
          wallet,
          questionId: asked.questionId,
          question: asked.question,
          closesAt: time(end),
          resolvesAt: time(resolve),
          transactions: [launch],
          instructions: signingInstructions(wallet, NEXT_STEP),
          warnings: [
            ...(end - state.now < 20n * 60n
              ? ['Less than 20 minutes to the close time: send this right away, or the factory will refuse it.']
              : []),
            ...(recheck.warning ? [recheck.warning] : []),
          ],
          next: { tool: 'register_market', arguments: { tx_hash: '<hash of the createMarket transaction once confirmed>' } },
        })
      }),
  )
}

function alreadyRegistered(error: unknown): boolean {
  if (!(error instanceof BackendHttpError)) return false
  const errors = (error.body as { errors?: { code?: unknown }[] } | null)?.errors
  return Array.isArray(errors) && errors.some((e) => e?.code === 'entity_already_exists')
}

export function registerRegisterMarket(server: McpServer): void {
  server.registerTool(
    'register_market',
    {
      title: 'Register a new Bopster market',
      description:
        'Step 4 of creating a Bopster market. Reads the confirmed createMarket transaction, returns the new market ' +
        "and its link, and tells the Bopster backend so it shows up on the site right away. The backend re-reads the " +
        "market from the chain itself, and its indexer would find it anyway; this only saves the wait.",
      inputSchema: { tx_hash: txHashSchema.describe('Hash of the confirmed createMarket transaction.') },
    },
    async (args) =>
      runTool(async () => {
        const state = await readCreationState()
        const receipt = await readSuccessfulReceipt(args.tx_hash as Hash)
        const created = marketFromReceipt(receipt, state.factory)
        if (!created) throw new ToolInputError(`Transaction ${args.tx_hash} created no market on the Bopster factory on ${chain.name}.`)

        let registered: boolean
        try {
          await sendJson('POST', '/market', { market_id: created.market.toLowerCase(), block_id: Number(created.blockNumber) })
          registered = true
        } catch (error) {
          if (alreadyRegistered(error)) registered = true
          else if (error instanceof BackendUnavailableError || error instanceof BackendHttpError) registered = false
          else throw error
        }

        return jsonResult({
          market: created.market,
          creator: created.creator,
          questionId: created.questionId,
          url: `${config.siteUrl}/markets/${created.market}`,
          closesAt: time(created.endTime),
          resolvesAt: time(created.resolveTime),
          registered,
          note: registered
            ? 'Live. Share the url; positions open until closesAt.'
            : "Live on-chain, but the backend didn't take the registration. Its indexer will pick the market up; the url works once it does.",
        })
      }),
  )
}

