# Security Policy

## Reporting a vulnerability

Don't open a public issue, pull request or discussion for a vulnerability.
Use GitHub's private vulnerability reporting instead:

1. Go to <https://github.com/marcosroigdev/bopster-mcp/security/advisories/new>
   (or **Security -> Advisories -> "Report a vulnerability"** in the repo header).
2. Describe the issue, how to reproduce it and its impact.
3. Submit. The report stays visible only to the maintainer and to you until
   the advisory is published.

Never include a private key or a seed phrase in a report.

## Scope

### In scope

- A `prepare_*` tool returning a transaction that does something other than what
  it says: a different contract, an approval for more than the stake or to the
  wrong spender, ETH attached.
- Markets created through the server that don't come from a template, or a launch
  that accepts a draft the server didn't sign.
- Anything that leaks a wallet session, `BOPSTER_MCP_SECRET` or
  `BOPSTER_DRAFT_SECRET`, or sends the shared secret anywhere but the Bopster API.
- Ways around the login limit or the request validation that put the server or
  the backend at risk.

### Out of scope

- The Bopster contracts. Report those in
  [bopster-market-contract](https://github.com/marcosroigdev/bopster-market-contract/security).
- Signing tools. For the CLI, use
  [bopster-cli](https://github.com/marcosroigdev/bopster-cli/security).
- Rate limits being reached under normal load.
