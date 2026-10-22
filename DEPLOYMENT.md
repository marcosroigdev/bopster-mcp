# Deployment

How to run your own Bopster MCP server: a Docker container bound to `127.0.0.1`, with nginx in
front for TLS. The examples use `mcp.bopster.fun`; replace it with your domain.

```
MCP client
    │  HTTPS  POST https://mcp.example.com/mcp
    ▼
nginx  (TLS, rate limit, proxy_buffering off)
    │  http://127.0.0.1:8788
    ▼
bopster-mcp container  (Node, Streamable HTTP)
    │
    ├── https://api.bopster.fun   Bopster API
    └── Base RPC                  contract reads
```

The server is stateless: no database, no keys, about 65 MB of RAM when idle.

---

## 1. Requirements

- A Linux server with Docker and the Docker Compose plugin.
- nginx and certbot (with the nginx plugin) on the host.
- A domain or subdomain pointing at the server.

```bash
docker --version && docker compose version
nginx -v && certbot --version
```

If the domain is proxied through Cloudflare, set SSL/TLS to **Full (strict)**. Keep in mind that
remote clients like Claude connect from their provider's servers, not from the user's country.

---

## 2. Get the code

```bash
git clone https://github.com/marcosroigdev/bopster-mcp.git
cd bopster-mcp
```

Give it its own directory. If the server runs other apps, keep this one in its own Compose
project so it gets its own Docker network.

---

## 3. Configure

```bash
cp .env.example .env
```

The defaults point at Bopster on Base mainnet. Things to set:

```dotenv
# Base RPC. It must return transaction receipts: market creation and sync_market read them.
# publicnode's free tier refuses them. A dedicated RPC is better than the public one, which
# rate-limits bursts.
BOPSTER_RPC_URL=https://mainnet.base.org

# Signs market drafts between the two creation steps. Without it, drafts in progress break on
# every restart. Generate one with: openssl rand -hex 32
BOPSTER_DRAFT_SECRET=<random string>

# Container name prefix: ${PROJECT_NAME}-mcp
PROJECT_NAME=bopster
```

`BOPSTER_MCP_SECRET` is only for the official server. Leave it empty on your own; the Bopster API
then rate-limits your requests per IP like anyone else's.

All variables are listed in the [README](README.md#configuration).

### Check against the backend

Market creation only makes sense if the server builds markets the backend trusts. Compare its
settings with the backend's published rules, from any machine with Node.js 22 and this repo (no
install needed):

```bash
BOPSTER_API_URL=https://api.bopster.fun \
BOPSTER_REALITY_ARBITRATOR=<value from .env> \
BOPSTER_REALITY_TIMEOUT_SECONDS=43200 \
node scripts/check-templates.mjs
```

---

## 4. Run the container

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=20 mcp
curl -s http://127.0.0.1:8788/health
```

A few seconds after startup `/health` should include `"rpc":{"host":"…","receipts":"ok"}`.

- `"refused"`: the RPC doesn't return receipts and market creation won't work. Change
  `BOPSTER_RPC_URL`.
- `"unchecked"`: the RPC didn't answer the check (rate limit, timeout). Look again after a restart.

The port must not be reachable from outside:

```bash
curl -s -m 3 http://<public-ip>:8788/health || echo "not exposed"
```

The container runs as the unprivileged `node` user, on a read-only filesystem, with all
capabilities dropped and `no-new-privileges`. It's limited to 256 MB of RAM, half a CPU and 128
processes, so a traffic spike can't take the whole server. Don't mount the Docker socket or other
apps' volumes into it, and never give it a key.

---

## 5. nginx and TLS

Get the certificate first. certbot's nginx plugin answers the challenge on its own, so the vhost
isn't needed yet:

```bash
sudo certbot certonly --nginx -d mcp.example.com -m you@example.com --agree-tos --deploy-hook "systemctl reload nginx"
```

Then install the vhost. Change `server_name`, the certificate paths and the log paths in the file
to your domain first:

```bash
sudo cp resources/nginx-host/mcp.bopster.fun.conf /etc/nginx/sites-available/mcp.example.com
sudo ln -s /etc/nginx/sites-available/mcp.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Without `sites-available` (most non-Debian distributions), put it in `/etc/nginx/conf.d/` with a
`.conf` name.

- `location /mcp` has `proxy_buffering off` and long read timeouts: Streamable HTTP can stream
  responses as SSE.
- The client address is taken from `CF-Connecting-IP` only for requests coming from Cloudflare's
  ranges, and passed on in `CF-Connecting-IP` and `X-Real-IP`, replacing whatever the client
  sent. The login limit depends on it. If Cloudflare adds ranges, update the list from
  <https://www.cloudflare.com/ips>. Not behind Cloudflare, nothing to change.

Renewal runs on certbot's timer, and the deploy hook reloads nginx:

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

## 6. Check the public endpoint

```bash
curl -s https://mcp.example.com/health
curl -s -o /dev/null -w "%{http_code}\n" https://mcp.example.com/mcp   # GET → 405
```

A full MCP handshake:

```bash
curl -s -X POST https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The answer comes as SSE and includes `serverInfo`:

```
event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"bopster-mcp","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

If `/health` works but this hangs, nginx is buffering the stream: check `proxy_buffering off`.

Then with a real client:

```bash
MCP_URL=https://mcp.example.com/mcp node scripts/smoke.mjs   # lists the tools, calls a few
pnpm inspector                                                # Streamable HTTP, your URL
```

Or add it to Claude, Cursor or another client (see [Connect](README.md#connect)) and ask for
something like *"List the top 3 Bopster markets by volume"*.

---

## 7. Updates

```bash
git pull
docker compose up -d --build
docker compose logs --tail=20 mcp
curl -s http://127.0.0.1:8788/health
```

Rollback:

```bash
git checkout <previous commit>
docker compose up -d --build
```

Day to day:

```bash
docker compose logs -f mcp
docker compose restart mcp
docker stats --no-stream $(docker compose ps -q mcp)
```

Logs rotate at 10 MB × 5 files. Docker checks `/health` every 15 s, and the container comes
back on its own if it crashes, unless you stopped it.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `curl http://127.0.0.1:8788/health` refused | Container down | `docker compose ps`, `docker compose logs mcp` |
| `/health` works, `/mcp` hangs | nginx buffering the stream | `proxy_buffering off` on `location /mcp` |
| `429 Too Many Requests` | nginx rate limit | Adjust the `limit_req` zones in the vhost |
| Every client shares one login limit | nginx sees Cloudflare's addresses as clients | Use the vhost's `set_real_ip_from` list, up to date with Cloudflare's ranges |
| "Bopster backend unavailable" | Backend down, or no egress from the server | `curl -s https://api.bopster.fun/health` from the server |
| Market creation says the server asks Reality.eth questions differently from the backend | `BOPSTER_REALITY_ARBITRATOR` or `BOPSTER_REALITY_TIMEOUT_SECONDS` don't match `GET /market-templates` | Fix them and `docker compose up -d`. `node scripts/check-templates.mjs` shows the difference |
| Market creation says the templates changed | The backend changed its template rules | Update `src/planner/templates.ts` and `test/fixtures/market-templates.v1.json` together |
| `get_fees` says no factory is configured | `BOPSTER_FACTORY_ADDRESS` missing | Set it and `docker compose up -d` |
| "over rate limit" | The public Base RPC throttles bursts (reads retry 3 times) | Use a dedicated RPC |
| `prepare_market_launch` or `register_market` fail with "Archive requests require a personal token"; `/health` says `"refused"` | The RPC doesn't return receipts (publicnode's free tier) | Switch `BOPSTER_RPC_URL`, `docker compose up -d`, check `/health`. With `BOPSTER_DRAFT_SECRET` set, just call `prepare_market_launch` again |
| TLS errors behind Cloudflare | SSL mode isn't Full (strict) | Set it to Full (strict) |
| Certificate not renewing | certbot timer | `sudo certbot renew --dry-run` |

---

## Security

- Only nginx is public. The container listens on `127.0.0.1`.
- No keys, no wallet, no funds, nothing sent on-chain. The `prepare_*` tools return unsigned
  transactions and the caller's wallet signs them.
- Transactions are only built for markets in the factory's registry, and approvals are for the
  exact stake.
- Addresses are validated with regexes, aliases are escaped with `encodeURIComponent`, and
  free-text filters go through `URLSearchParams`.
- The only backend writes are the public `PUT /market/{address}` and `POST /market` hooks, the
  wallet login (`POST /auth/wallet/login`) with the one-time message the agent signed, and the
  metadata pin for a new market, made with the session that login opens. A portfolio read uses
  the same kind of session. Each session is used for one request and never stored.

To report a vulnerability, see [SECURITY.md](SECURITY.md).
