// End-to-end check of the prepare_* tools on an anvil fork of Base mainnet: a market is created on
// the fork, then every position, settlement and claim transaction sent is one the MCP prepared.
// Nothing touches the real chain. It starts its own MCP server against the fork. Run:
//
//   anvil --fork-url <a Base mainnet RPC> --port 8545
//   pnpm build && node scripts/e2e-fork.mjs
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createTestClient, http, publicActions, walletActions, keccak256, encodeAbiParameters, pad, toHex, parseEventLogs, formatUnits } from 'viem'
import { base } from 'viem/chains'

const FORK = 'http://127.0.0.1:8545'
const FACTORY = '0x11a2a549286567f7427d990423e5a3560ea16750'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ALICE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const BOB = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const t = createTestClient({ chain: base, mode: 'anvil', transport: http(FORK) }).extend(publicActions).extend(walletActions)

const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]
const factoryAbi = [
  { type: 'function', name: 'reality', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'createMarket', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }, { type: 'string' }, { type: 'uint64' }, { type: 'uint64' }], outputs: [{ type: 'address' }] },
  { type: 'event', name: 'MarketCreated', inputs: [{ name: 'market', type: 'address', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'questionId', type: 'bytes32', indexed: true }, { name: 'endTime', type: 'uint64' }, { name: 'resolveTime', type: 'uint64' }, { name: 'metadataURI', type: 'string' }] },
]
const realityAbi = [
  { type: 'function', name: 'askQuestion', stateMutability: 'payable', inputs: [{ type: 'uint256' }, { type: 'string' }, { type: 'address' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'submitAnswer', stateMutability: 'payable', inputs: [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'isFinalized', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
]
const marketAbi = [
  { type: 'function', name: 'yesPosition', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'noPosition', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
]

const usdc = (a) => t.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [a] })
const fmt = (v) => formatUnits(v, 6)
let failures = 0
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  - ' + detail : ''}`); if (!ok) failures++ }
const send = async (from, tx) => {
  const hash = await t.sendTransaction({ account: from, to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) })
  const r = await t.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${tx.action ?? 'tx'} reverted`)
  return r
}

// Give both test wallets 100 USDC: FiatToken v2.2 keeps balances in the mapping at slot 9.
for (const who of [ALICE, BOB]) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, 9n]))
  await t.setStorageAt({ address: USDC, index: slot, value: pad(toHex(100_000_000n)) })
}
check('test wallets funded with 100 USDC', (await usdc(ALICE)) === 100_000_000n && (await usdc(BOB)) === 100_000_000n)

// A fresh market, created the way the site does it: the Reality question first. The factory wants
// 15 min to 10 days of trading.
const now = (await t.getBlock()).timestamp
const end = now + 1200n, resolve = end + 600n
const reality = await t.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'reality' })
const askHash = await t.writeContract({ account: ALICE, address: reality, abi: realityAbi, functionName: 'askQuestion', args: [0n, 'Fork test: will the MCP flow work?␟misc␟en', ALICE, 60, Number(resolve), now] })
const askReceipt = await t.waitForTransactionReceipt({ hash: askHash })
const questionId = askReceipt.logs.find((l) => l.address.toLowerCase() === reality.toLowerCase()).topics[1]
const createHash = await t.writeContract({ account: ALICE, address: FACTORY, abi: factoryAbi, functionName: 'createMarket', args: [questionId, 'ipfs://fork-test', end, resolve] })
const createReceipt = await t.waitForTransactionReceipt({ hash: createHash })
if (createReceipt.status !== 'success') throw new Error('createMarket reverted on the fork')
const MARKET = parseEventLogs({ abi: factoryAbi, logs: createReceipt.logs, eventName: 'MarketCreated' })[0].args.market
console.log('market created on fork:', MARKET)

const client = new Client({ name: 'e2e', version: '0' })
const MCP_PORT = 8791
const mcp = spawn('node', ['dist/bin/http.js'], {
  env: { ...process.env, MCP_PORT: String(MCP_PORT), BOPSTER_RPC_URL: FORK, BOPSTER_FACTORY_ADDRESS: FACTORY },
  // Not inherited: a child holding this process's stdout open keeps any pipe reading it waiting.
  stdio: 'ignore',
})
process.on('exit', () => mcp.kill('SIGKILL'))
await new Promise((resolve) => setTimeout(resolve, 1500))
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`)))
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content[0].text
  let body; try { body = JSON.parse(text) } catch { body = text }
  return { isError: res.isError ?? false, body }
}

// 1. Quote, then Alice takes YES 6 in two goes and Bob takes NO 3.
const q = await call('quote_position', { market: MARKET, side: 'YES', amount: '5' })
check('quote_position: 5 on YES alone would pay 4.84 (stake minus 3.2%)', !q.isError && q.body.payoutIfWins === '4.84 USDC', `payoutIfWins=${q.body.payoutIfWins}, warnings=${q.body.warnings?.length}`)

let p = await call('prepare_position', { market: MARKET, side: 'YES', amount: '5', wallet: ALICE })
check('prepare_position: approve, then positionYes', !p.isError && p.body.transactions.map((x) => x.action).join('>') === 'approve>positionYes', JSON.stringify(p.isError ? p.body : p.body.transactions.map((x) => x.action)))
for (const tx of p.body.transactions) await send(ALICE, tx)
check('Alice holds 5 on YES after sending them', (await t.readContract({ address: MARKET, abi: marketAbi, functionName: 'yesPosition', args: [ALICE] })) === 5_000_000n)

p = await call('prepare_position', { market: MARKET, side: 'YES', amount: '1', wallet: ALICE })
check('a second position approves again (the first spent the allowance)', p.body.transactions.map((x) => x.action).join('>') === 'approve>positionYes')
for (const tx of p.body.transactions) await send(ALICE, tx)

p = await call('prepare_position', { market: MARKET, side: 'NO', amount: '3', wallet: BOB })
for (const tx of p.body.transactions) await send(BOB, tx)
check('Bob holds 3 on NO', (await t.readContract({ address: MARKET, abi: marketAbi, functionName: 'noPosition', args: [BOB] })) === 3_000_000n)

const broke = await call('prepare_position', { market: MARKET, side: 'NO', amount: '1000', wallet: BOB })
check('refuses a stake the wallet cannot cover', broke.isError && /holds/.test(broke.body), broke.body)

let c = await call('prepare_claim', { market: MARKET, wallet: ALICE })
check('claim is not ready while positions are open', c.body.outcome === 'not_ready', c.body.summary)

// 2. Past the resolve time on the chain's clock, before the oracle answers.
await t.increaseTime({ seconds: 1900 }); await t.mine({ blocks: 1 })
const late = await call('prepare_position', { market: MARKET, side: 'YES', amount: '1', wallet: ALICE })
check('refuses positions after the end time, by chain time', late.isError && /closed/.test(late.body), late.body)
let f = await call('prepare_finalize', { market: MARKET })
check('finalize waits for Reality.eth', f.body.state === 'waiting', f.body.summary)

// 3. YES is answered and the 60 s timeout passes.
// Wait for the answer to be mined before moving the clock: if it lands in the block the clock
// jump produces, its 60 s window only starts there and the answer isn't final yet.
const answerHash = await t.writeContract({ account: BOB, address: reality, abi: realityAbi, functionName: 'submitAnswer', args: [questionId, pad(toHex(1n)), 0n], value: 1n })
if ((await t.waitForTransactionReceipt({ hash: answerHash })).status !== 'success') throw new Error('submitAnswer reverted on the fork')
await t.increaseTime({ seconds: 120 }); await t.mine({ blocks: 1 })
check('Reality.eth answer is final on the fork', await t.readContract({ address: reality, abi: realityAbi, functionName: 'isFinalized', args: [questionId] }))

f = await call('prepare_finalize', { market: MARKET })
check('finalize is ready and says YES won', f.body.state === 'ready' && /YES won/.test(f.body.summary), `${f.body.summary} reward=${f.body.resolverReward}`)

c = await call('prepare_claim', { market: MARKET, wallet: ALICE })
check('Alice: finalize, then claim', c.body.outcome === 'claim' && c.body.transactions.map((x) => x.action).join('>') === 'finalize>claim', `${c.body.amount} via ${c.body.transactions?.map((x) => x.action)}`)
const before = await usdc(ALICE)
for (const tx of c.body.transactions) await send(ALICE, tx)
const gained = (await usdc(ALICE)) - before
// Pool 9 USDC: 3.2% off leaves 8.712, all to Alice's YES. She also sent finalize (+0.018 resolver
// reward) and created the market (+0.09, the 1% creator fee).
check('Alice received the quoted claim, plus the resolver reward and her creator fee', fmt(gained) === '8.82', `gained ${fmt(gained)} USDC = claim ${c.body.amount} + reward ${f.body.resolverReward} + creator fee 0.09`)

check('Bob lost', (await call('prepare_claim', { market: MARKET, wallet: BOB })).body.outcome === 'lost')
check('Alice cannot claim twice', (await call('prepare_claim', { market: MARKET, wallet: ALICE })).body.outcome === 'already_claimed')
check('market now reads as settled', (await call('prepare_finalize', { market: MARKET })).body.state === 'settled')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
await client.close(); process.exit(failures ? 1 : 0)
