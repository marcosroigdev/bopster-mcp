// End-to-end check of market creation on an anvil fork of Base mainnet. A local stand-in for the
// Bopster backend (nonce, login, metadata pin, registration) verifies the login signature the way
// the real one does, so nothing here touches production: no sessions, no pins, no registrations.
// Every on-chain transaction sent is one the MCP prepared. Run:
//
//   anvil --fork-url <a Base mainnet RPC> --port 8545
//   pnpm build && node scripts/e2e-fork-create.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createTestClient, http, publicActions, walletActions, verifyMessage, getAddress, encodeFunctionData } from 'viem'
import { base } from 'viem/chains'

const FORK = 'http://127.0.0.1:8545'
const BACKEND_PORT = 8799
const MCP_PORT = 8790
const FACTORY = '0x11a2a549286567f7427d990423e5a3560ea16750'
const ARBITRATOR = '0xcB4B48d2A7a44247A00048963F169d2b4Ab045a6'
const ALICE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const t = createTestClient({ chain: base, mode: 'anvil', transport: http(FORK) }).extend(publicActions).extend(walletActions)

let failures = 0
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  - ' + detail : ''}`); if (!ok) failures++ }

// --- The backend stand-in -------------------------------------------------------------------
// Serves the published template contract, with the fork's (mainnet) arbitrator in its `reality`.
const templates = JSON.parse(readFileSync(new URL('../test/fixtures/market-templates.v1.json', import.meta.url), 'utf8'))
templates.data.reality.arbitrator = ARBITRATOR.toLowerCase()
const nonces = new Map()
const sessions = new Set()
const seen = { logins: 0, pins: [], registrations: [] }
const backend = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${BACKEND_PORT}`)
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : null
  const reply = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }

  if (req.method === 'GET' && url.pathname === '/market-templates') {
    seen.templateReads = (seen.templateReads ?? 0) + 1
    return reply(200, templates)
  }
  if (req.method === 'GET' && url.pathname === '/auth/wallet/nonce') {
    const nonce = randomUUID()
    nonces.set(nonce, url.searchParams.get('address'))
    return reply(200, { data: { nonce, expiresAt: Math.floor(Date.now() / 1000) + 300 } })
  }
  if (req.method === 'POST' && url.pathname === '/auth/wallet/login') {
    seen.logins++
    const issuedTo = nonces.get(body.nonce)
    nonces.delete(body.nonce)
    const message = `Bopster Fun login\naddress=${body.address}\nnonce=${body.nonce}`
    // Like the real backend, a malformed signature is just an invalid one.
    const valid = issuedTo === body.address && (await verifyMessage({ address: body.address, message, signature: body.signature }).catch(() => false))
    if (!valid) return reply(401, { errors: [{ code: 'invalid_signature', message: 'Signature does not match the login message', context: {} }] })
    const token = randomUUID()
    sessions.add(token)
    return reply(200, { data: { access_token: token, expires_in: 3600 } })
  }
  if (req.method === 'GET' && url.pathname.startsWith('/user-view/')) {
    return reply(404, { errors: [{ code: 'not_found' }] })
  }
  if (req.method === 'POST' && url.pathname === '/ipfs/metadata') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!sessions.has(token)) return reply(401, { errors: [{ code: 'unauthorized' }] })
    seen.pins.push(body)
    return reply(201, { data: { cid: 'bafyforktest', metadataUri: 'ipfs://bafyforktest' } })
  }
  if (req.method === 'POST' && url.pathname === '/market') {
    if (seen.registrations.includes(body.market_id)) {
      return reply(409, { errors: [{ code: 'entity_already_exists', context: { market_address: body.market_id } }] })
    }
    seen.registrations.push(body.market_id)
    return reply(201, { data: { id: randomUUID(), marketAddress: body.market_id } })
  }
  reply(404, { errors: [{ code: 'not_found' }] })
})
await new Promise((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', resolve))

// --- The MCP server, pointed at the fork and the stand-in -----------------------------------
const mcp = spawn('node', ['dist/bin/http.js'], {
  env: {
    ...process.env,
    MCP_PORT: String(MCP_PORT),
    BOPSTER_API_URL: `http://127.0.0.1:${BACKEND_PORT}`,
    BOPSTER_RPC_URL: FORK,
    BOPSTER_FACTORY_ADDRESS: FACTORY,
    BOPSTER_REALITY_ARBITRATOR: ARBITRATOR,
  },
  // Not inherited: a child holding this process's stdout open keeps any pipe reading it waiting.
  stdio: 'ignore',
})
await new Promise((resolve) => setTimeout(resolve, 1500))

const client = new Client({ name: 'e2e-create', version: '0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`)))
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content[0].text
  let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
  return { isError: res.isError ?? false, body: parsed }
}
async function send(tx) {
  const hash = await t.sendTransaction({ account: ALICE, to: tx.to, data: tx.data, value: BigInt(tx.value) })
  const receipt = await t.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${tx.action} reverted`)
  return hash
}
async function signedLogin() {
  const login = await call('get_login_message', { wallet: ALICE })
  const signature = await t.signMessage({ account: ALICE, message: login.body.message })
  return { nonce: login.body.nonce, signature, message: login.body.message }
}

const REALITY_ABI = [
  { type: 'function', name: 'askQuestion', stateMutability: 'payable', inputs: [{ type: 'uint256' }, { type: 'string' }, { type: 'address' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
]
const TEMPLATE_KEYS = ['price_threshold_v1', 'event_outcome_v1', 'before_date_v1', 'price_change_v1', 'compare_assets_v1']
/**
 * The metadata half of the backend's high_trust rule, for the metadata this test pinned: a known
 * template, the canonical question, a deadlineUtc on the resolve time and a public source. The
 * backend also checks the Reality.eth question itself.
 */
function meetsTrustRule(meta, canonicalQuestion, resolveTime) {
  return (
    TEMPLATE_KEYS.includes(meta.templateId) &&
    meta.question === canonicalQuestion &&
    Date.parse(meta.templateParams?.deadlineUtc ?? '') / 1000 === resolveTime &&
    /^https?:\/\//.test(meta.sourceUrl ?? '')
  )
}
const utcLabel = (s) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

try {
  const chainNow = Number((await t.getBlock()).timestamp)
  // On a whole minute, like the site's date picker.
  const endTime = Math.ceil((chainNow + 30 * 60) / 60) * 60
  const draft = {
    wallet: ALICE,
    title: 'Fork test market',
    template: { type: 'event_outcome', event: 'the Bopster MCP launch a market on a fork of Base' },
    category: 'Tech',
    source_url: 'https://github.com/marcosroigdev/bopster-mcp',
    end_time: new Date(endTime * 1000).toISOString(),
    resolution_delay_minutes: 15,
    accept_terms: true,
  }
  const expectedQuestion = `Will the Bopster MCP launch a market on a fork of Base before ${utcLabel(endTime + 15 * 60)}?`

  // 1. The login message is the one the backend verifies.
  const first = await signedLogin()
  check('get_login_message hands back the backend login message', first.message === `Bopster Fun login\naddress=${ALICE.toLowerCase()}\nnonce=${first.nonce}`)

  // 2. A draft that breaks the rules is refused before the signature is spent.
  const { template: _template, ...withoutTemplate } = draft
  const freeText = await call('prepare_market_question', { ...withoutTemplate, ...first, question: 'Will anything I like happen soon?' })
  check('refuses a free-text question: there is no way to pass one', freeText.isError, String(freeText.body).slice(0, 120))
  const sports = await call('prepare_market_question', { ...draft, ...first, category: 'Sports' })
  check('asks whether a Sports market is a match', sports.isError && /sports_match/.test(sports.body), sports.body)
  const tooSoon = await call('prepare_market_question', { ...draft, ...first, end_time: new Date(Math.ceil((chainNow + 10 * 60) / 60) * 60 * 1000).toISOString() })
  check('refuses an end_time too close, listing why', tooSoon.isError && /minutes from now/.test(tooSoon.body), tooSoon.body)
  const noName = await call('prepare_market_question', { ...draft, ...first })
  check('asks for creator_name when the wallet has no profile', noName.isError && /creator_name/.test(noName.body), noName.body)
  check('no refusal spent the login', seen.logins === 0)

  // 3. A forged signature is refused by the backend.
  const forged = await call('prepare_market_question', { ...draft, nonce: first.nonce, signature: `0x${'11'.repeat(65)}`, creator_name: 'Fork Tester' })
  check('a signature the backend rejects says how to sign, from its error code', forged.isError && /doesn't match the login message/.test(forged.body), forged.body)

  // 4. The real thing.
  const login = await signedLogin()
  const q = await call('prepare_market_question', { ...draft, ...login, creator_name: 'Fork Tester' })
  check('prepare_market_question returns askQuestion', !q.isError && q.body.transactions?.[0]?.action === 'askQuestion', q.isError ? q.body : '')
  const pin = seen.pins.at(-1)
  check('the question is the template, worded like the site', q.body.question === expectedQuestion, q.body.question)
  check(
    'the pinned metadata is the template draft, under the session token',
    pin?.title === draft.title && pin?.question === expectedQuestion && pin?.questionType === 'template' &&
      pin?.templateId === 'event_outcome_v1' && pin?.templateParams?.event === draft.template.event &&
      pin?.creator === 'Fork Tester' && pin?.wallet === getAddress(ALICE) && pin?.sourceUrl === draft.source_url,
    JSON.stringify(pin),
  )
  check('the metadata meets the backend\'s high_trust rule', meetsTrustRule(pin, expectedQuestion, endTime + 15 * 60))
  const questionTx = await send(q.body.transactions[0])

  // Every way around the template is closed.
  const altered = await call('prepare_market_launch', { ...q.body.next.arguments, question_tx_hash: questionTx, resolve_time: q.body.next.arguments.resolve_time + 60 })
  check('refuses an altered draft', altered.isError && /only launches markets/.test(altered.body), altered.body)
  const renamed = await call('prepare_market_launch', { ...q.body.next.arguments, question_tx_hash: questionTx, question: 'Will anything I like happen soon?' })
  check('refuses a draft whose question was swapped', renamed.isError && /only launches markets/.test(renamed.body), renamed.body)
  const madeUp = await call('prepare_market_launch', { ...q.body.next.arguments, question_tx_hash: questionTx, draft_token: 'bWFkZS11cA' })
  check('refuses a made-up draft token', madeUp.isError && /only launches markets/.test(madeUp.body), madeUp.body)
  const handAsked = await send({
    action: 'askQuestion (by hand, free text)',
    to: q.body.transactions[0].to,
    data: encodeFunctionData({
      abi: REALITY_ABI,
      functionName: 'askQuestion',
      args: [0n, 'Will anything I like happen soon?', ARBITRATOR, 43200, q.body.next.arguments.resolve_time, 42n],
    }),
    value: '0',
  })
  const smuggled = await call('prepare_market_launch', { ...q.body.next.arguments, question_tx_hash: handAsked })
  check('refuses a genuine draft pointed at a free-text question asked by hand', smuggled.isError && /not the drafted question/.test(smuggled.body), smuggled.body)

  const launch = await call('prepare_market_launch', { ...q.body.next.arguments, question_tx_hash: questionTx })
  check('prepare_market_launch returns createMarket', !launch.isError && launch.body.transactions?.[0]?.action === 'createMarket', launch.isError ? launch.body : '')
  const marketTx = await send(launch.body.transactions[0])

  const reg = await call('register_market', { tx_hash: marketTx })
  check('register_market returns the new market and its link', !reg.isError && /^0x[0-9a-fA-F]{40}$/.test(reg.body.market) && reg.body.url.endsWith(reg.body.market), JSON.stringify(reg.body))
  check('the backend got the registration with the right block', seen.registrations.at(-1) === reg.body.market.toLowerCase())
  const again = await call('register_market', { tx_hash: marketTx })
  check('registering twice still reads as registered', again.body.registered === true)
  const twice = await call('prepare_market_launch', { ...q.body.next.arguments, question_tx_hash: questionTx })
  check('refuses to launch a second market on the same question', twice.isError && /already has a market/.test(twice.body), twice.body)

  // 5. The new market works with the rest of the tools.
  const quote = await call('quote_position', { market: reg.body.market, side: 'YES', amount: '5' })
  check('the new market takes quotes, so it passes the registry check', !quote.isError, quote.isError ? quote.body : quote.body.payoutIfWins)
  const closes = Date.parse(reg.body.closesAt) / 1000
  check('it closes when the draft said', closes === Date.parse(draft.end_time) / 1000)
  check("the backend's Reality settings were checked, from one cached read", seen.templateReads === 1, `${seen.templateReads} read(s)`)
} finally {
  await client.close().catch(() => {})
  mcp.kill('SIGKILL')
  backend.close()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures ? 1 : 0)
