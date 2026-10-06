# mimo-mcp-server

Zero-dependency MCP (stdio) server that exposes the local **`mimo` CLI** (Xiaomi MiMo Desktop / MiMoCode) as tools:

| Tool | Purpose |
| --- | --- |
| `mimo_run` | Dispatch a coding/build/debug task to `mimo run` |
| `mimo_continue` | Continue a mimo session (`sessionId` / `latest`) |
| `mimo_status` | Live per-project snapshot of what mimo is doing |

## Usage

```bash
node mimo-mcp-server.mjs          # stdio MCP server
node mimo-mcp-server.mjs --check  # self-test: list tools, exit
```

### Register

```text
Claude Code : claude mcp add mimo -- node C:\path\to\mimo-mcp-server.mjs
Codex       : [mcp_servers.mimo] command = "node", args = ["...\\mimo-mcp-server.mjs"]
```

## Environment

| Var | Meaning |
| --- | --- |
| `MIMO_BIN` / `MIMO_CLI` | Override mimo executable |
| `MIMO_MCP_CWD` / `MIMO_BRIDGE_CWD` | Default working directory |
| `MIMO_MCP_LIVE_FILE` | Path of `mcp-live.json` for the home status light |

## Full host control

Every invocation is non-interactive: `mimo run --format json --dangerously-skip-permissions`. Mode/model/variant/dir/session/timeout are all decided by the host. mimo never prompts.

## Live status

Each run parses NDJSON events and folds tool/text steps into an in-memory snapshot (also written to `mcp-live.json` for the DSH home indicator). Call `mimo_status` while a run is in flight.

## Fallback

On rate-limit/network/auth failure the result includes `fallback=true` / `status=FALLBACK_TO_DSH`. MCP has no dialog — the calling agent should finish with native tools and never loop mimo calls.
