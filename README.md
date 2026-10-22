<p>
  <img src="bopster-logo-mini.png" alt="Bopster Fun" width="200" />
</p>

# Bopster MCP

**MCP server for Bopster prediction markets on Base.**
AI agents use it to read markets and prepare transactions. It never holds keys or sends anything.

[![CI](https://github.com/marcosroigdev/bopster-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/marcosroigdev/bopster-mcp/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-green)

Public server: `https://mcp.bopster.fun/mcp`

---

## What it does

[Bopster](https://bopster.fun) is a prediction market on Base. People take YES or NO positions in
USDC on a question and the winning side splits the pool. This server exposes it to any
[Model Context Protocol](https://modelcontextprotocol.io) client (Claude, Cursor and others).

- Read tools call the public Bopster API (`https://api.bopster.fun`) and the Bopster contracts on Base.
- The `prepare_*` tools return **unsigned** transactions. The agent's own wallet signs and sends them.
- No keys, no custody, no stored sessions. It doesn't answer Reality.eth questions or arbitrate either.

To sign from a terminal, use [bopster-cli](https://github.com/marcosroigdev/bopster-cli). It checks
every transaction against the chain before signing it, so you don't have to trust this server.

Contracts: [bopster-market-contract](https://github.com/marcosroigdev/bopster-market-contract).

---

## Connect

Remote, the public server:

```json
{
  "mcpServers": {
    "bopster": { "url": "https://mcp.bopster.fun/mcp" }
  }
}
```

In Claude, add the same URL as a custom connector.

Local, over stdio (after `pnpm build`):

```json
{
  "mcpServers": {
    "bopster": {
      "command": "node",
      "args": ["/absolute/path/to/bopster-mcp/dist/bin/stdio.js"],
      "env": {
        "BOPSTER_RPC_URL": "https://mainnet.base.org",
        "BOPSTER_FACTORY_ADDRESS": "0x11a2a549286567f7427d990423e5a3560ea16750",
        "BOPSTER_REALITY_ARBITRATOR": "0xcB4B48d2A7a44247A00048963F169d2b4Ab045a6"
      }
    }
  }
}
```

---

## Tools

| Tool | What it does |
| --- | --- |
| `list_markets` | Search and list markets: status, category, text, sorting, pagination. |
| `get_market` | One market by address: pools, phase, oracle, and a wallet's position if you pass one. |
| `get_leaderboard` | Top creators, predictors or oracles for a period. |
| `get_portfolio` | Your own positions, payouts and refunds. Needs a login: `get_login_message`, sign it, then call this with wallet, nonce and signature. |
| `get_user_profile` | Public profile and activity, by wallet or alias. |
| `get_creator_profile` | Creator profile: alias, avatar, verified badge, stats. |
| `get_fees` | Protocol, creator and resolver fees, read from the factory contract. |
| `ping_health` | Checks that the backend is up. |
| `quote_position` | What a YES/NO position would pay if its side wins, with the pools as they are now. |
| `prepare_position` | Approval for exactly the stake, then `positionYes`/`positionNo`. Checks the market is open and the wallet has the funds. |
| `prepare_claim` | What a wallet can take out of a market and the transactions to do it, in order: `finalize` if nobody has, then `claim` or `claimRefund`. Says why when there's nothing. |
| `prepare_finalize` | Whether a market can be settled now, the transaction, and the resolver reward for whoever sends it. Covers the emergency refund. |
| `sync_market` | Asks the backend to re-read a market after a transaction confirms, so the site shows it straight away. |
| `get_login_message` | One-time message for the wallet to sign (EIP-191). Step 1 of creating a market, and what `get_portfolio` needs. |
| `prepare_market_question` | Step 2: builds the question from one of the site's five templates, checks every rule, pins the metadata and returns the Reality.eth `askQuestion`. |
| `prepare_market_launch` | Step 3: checks the confirmed question is the drafted one and returns `createMarket`. |
| `register_market` | Step 4: reads the new market from the receipt, returns its link and tells the backend. |

Amounts from the API are USDC base units (6 decimals). `list_markets` adds `*_formatted` and
`*_iso` fields. The `quote_` and `prepare_` tools take whole units: `"5"` is 5 USDC.

---

## Creating a market

Same steps as on the site. Each call returns the arguments for the next one in `next`.

```
get_login_message → sign → prepare_market_question → send askQuestion
  → prepare_market_launch → send createMarket → register_market
```

- Templates only. Agents can't write a free-text question. They pick one of the five
  templates (`price_threshold`, `event_outcome`, `before_date`, `price_change`, `compare_assets`)
  and fill in its fields. The question is worded exactly as on bopster.fun.
- Checked before anything is signed. Template fields, a title of 2 to 120 bytes, a public
  `source_url`, a close on a whole minute between 20 minutes and 10 days away, and one of the
  site's resolution delays. A Sports match closes at kick-off and the sport sets the delay.
- Only its own drafts. `prepare_market_question` signs the draft (HMAC with
  `BOPSTER_DRAFT_SECRET`) and `prepare_market_launch` refuses anything it didn't sign, or a
  Reality.eth question with different text. The contracts are permissionless, so anyone calling
  them directly can still make a free-text market. The backend scores those `low_trust`.
- No early answers. The question opens for answers at the resolve time.

The backend only marks a market `high_trust` when:

- the params pass the template rules and `metadata.question` is the canonical text;
- `deadlineUtc` equals the market's `resolveTime`;
- the Reality.eth question, read from the contract, has the same text, template 0, Bopster's
  arbitrator and answer window, and opens at `resolveTime`.

The backend publishes its template rules at `GET /market-templates`. This server checks its arbitrator and answer window against them before
preparing a market, `test/templateContract.test.ts` holds the templates to a saved copy, and
`pnpm check:templates` compares that copy with a live backend.

---

## Safety

- Only Bopster markets. Every market is checked against the factory's registry
  (`allMarkets`) before anything is built, so a look-alike contract can't get an approval.
- Exact approvals. `prepare_position` always approves exactly the stake, never more, and
  the position spends all of it. It doesn't skip the approval based on an allowance read: behind
  a load-balanced RPC that read can be stale.
- Gas limits included. Each transaction comes with `gas`, about twice what it used in tests.
  An estimate made right after the previous transaction can hit a node that hasn't seen it yet.
  Only the gas used is charged.
- Chain time. Open, closed and ready are decided with the block timestamp, like the contract.
- Login limit. Each client gets 3 login messages a minute, keyed by the address nginx sets in
  `CF-Connecting-IP` (then `X-Real-IP`). A login can pin metadata to IPFS before any
  transaction, and wallets are free.
- Same rules as the contract. Payouts, fees and the settle/claim/refund order follow the
  `BopsterMarket` source verified on Base mainnet.

---

## Development

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm build
pnpm test
```

Run it:

```bash
cp .env.example .env  # the scripts below read it
pnpm start:stdio      # stdio, for local MCP clients
pnpm start            # HTTP on port 8788, all interfaces: http://127.0.0.1:8788/mcp
node scripts/smoke.mjs
pnpm inspector        # MCP Inspector, then point it at node dist/bin/stdio.js
```

### Fork tests

Both suites run on an anvil fork of Base mainnet, start their own server against it and only
send transactions the tools prepared. Market creation uses a local stand-in for the backend that
checks login signatures like the real one. CI runs them in the `e2e` job (set the `BASE_RPC_URL`
repository variable for a dedicated RPC). Start the fork right before running them: public RPCs
stop serving a fork's block after a few minutes.

```bash
anvil --fork-url <Base mainnet RPC> --port 8545
pnpm build && pnpm test:e2e
```

---

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `BOPSTER_API_URL` | `https://api.bopster.fun` | Bopster API. |
| `BOPSTER_MCP_SECRET` | none | Only for the official server. Sent as `X-Bopster-Mcp-Secret` to `BOPSTER_API_URL` and nowhere else. |
| `BOPSTER_HTTP_TIMEOUT_MS` | `10000` | Timeout for backend requests. |
| `MCP_PORT` | `8788` | HTTP port. |
| `BOPSTER_CHAIN_ID` | `8453` | `8453` (Base) or `84532` (Base Sepolia). |
| `BOPSTER_RPC_URL` | `https://mainnet.base.org` | Base RPC. The public one rate-limits bursts, so use a dedicated one in production. It must return transaction receipts (publicnode's free tier doesn't). Checked at startup and shown on `/health`. |
| `BOPSTER_FACTORY_ADDRESS` | none | BopsterFactory. The `get_fees`, `quote_`, `prepare_`, `sync_` and `register_` tools need it. |
| `BOPSTER_REALITY_ARBITRATOR` | none | Arbitrator for new questions. Empty turns market creation off. Mainnet: `0xcB4B48d2A7a44247A00048963F169d2b4Ab045a6`. |
| `BOPSTER_REALITY_TIMEOUT_SECONDS` | `43200` | Answer window for new questions (12 h, as on the site). |
| `BOPSTER_REALITY_ANSWER_REWARD_WEI` | `0` | Bounty sent with new questions. |
| `BOPSTER_SITE_URL` | `https://bopster.fun` | Where market links point. |
| `BOPSTER_DRAFT_SECRET` | random | Signs market drafts between steps 2 and 3. Set it (32+ bytes) so drafts survive a restart. |

---

## Self-hosting

Docker image behind nginx: see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## License

[MIT](LICENSE)
