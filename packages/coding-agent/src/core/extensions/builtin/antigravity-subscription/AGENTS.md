# antigravity-subscription

Builtin provider lane that drives the official `agy` CLI in resident stream-JSON mode. agy owns authentication and conversation storage; senpi owns tool execution through a loopback MCP bridge.

## File roles

| File | Role |
|---|---|
| `index.ts` | Provider registration, model refresh, restart binding restore, and lifecycle teardown |
| `session.ts` | Resident process registry, continuity decisions, workspace/process lifecycle, idle and LRU eviction |
| `stream.ts` | Provider event mapping, held MCP tool-call handoff, usage, abort, and one-shot auxiliary turns |
| `oauth-login.ts` | Ambient agy availability, explicit opt-in, permission-rule consent, and sentinel credentials |
| `settings.ts` | Layered provider settings and persisted enabled state |
| `availability.ts` | Cached ambient login and model probes |
| `models.ts` | Static/dynamic model catalog and cache |
| `bridge-server.ts` | Token-routed loopback MCP server |
| `tool-bridge.ts` | Held MCP call queue joining agy to senpi tool results |
| `workspace.ts` | Private per-session agy agent and MCP configuration |
| `stream-parser.ts` | Bounded incremental agy NDJSON parser |
| `prompt.ts` | Text-only delta and bootstrap transcript rendering |

## Invariants

- Senpi never reads or stores a Google or Antigravity token. agy authenticates itself; the stored sentinel is not sent to agy.
- The agy agent declares `tools: []`. Only the `senpi-host` MCP tools are available.
- The global `mcp(senpi-host/*)` permission rule is installed only after explicit `/login` consent.
- Any agy builtin-tool step fails closed and destroys that conversation binding.
- Main turns reuse one resident process; a surviving conversation reattaches with `--conversation` after process restart.
- No `SENPI_*` environment variable reaches agy. Every spawn uses the explicit allowlist in `environment.ts`.
- Active turns and sessions with pending bridge calls are never reaped or evicted.

