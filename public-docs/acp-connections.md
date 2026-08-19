# Operator-Configured ACP Connections

Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) over stdio can be plugged into Claxedo as a first-class harness — no code
change, no fork, no bundled binary. An operator registers a **connection**: a
stable slug, a display label, and the command to spawn. Claxedo then treats it
exactly like a built-in harness: it appears in the app's harness picker, runs
sessions through the same `AcpHarnessAdapter`, and its sessions persist and
reload like any other.

This is the extension point for products that want to connect their own agent
to a Claxedo server.

## Identity Model

| Term | Meaning |
| --- | --- |
| Connection id (slug) | Lowercase stable identifier matching `^[a-z][a-z0-9-]{0,63}$`, e.g. `gemini`. |
| Canonical harness key | `acp:<slug>`, e.g. `acp:gemini`. This is the identity sessions store and the app selects. |
| Descriptor | The label + command + env resolved from the registry when a process must start. |

Sessions and configuration store only the **logical identity** (`acp:<slug>`).
The process descriptor is resolved from the accepted registry each time a
process starts, so editing a connection's `command` or `env` applies on the
next process start without rewriting any session.

The built-in ids (`claude`, `codex`, `cursor`, `opencode`, `pi`, and the
`-acp`/`-sdk` access variants) are reserved; a connection slug never collides
with them because operator identities always travel under the `acp:` prefix.

## Config Schema

Connections live in the trusted user config file
`~/.claxedo/user-agent-config.json` (honors `CLAXEDO_DATA_DIR`), under the
`acp` map:

```jsonc
{
  "mcp": {},
  "acp": {
    "gemini": {
      "label": "Gemini",
      // command[0] is the executable; the rest are arguments, passed verbatim.
      "command": ["/usr/local/bin/gemini-cli", "--experimental-acp"],
      // Extra process environment applied over the runtime environment.
      "env": { "GEMINI_API_KEY": "..." },
      // Narrow generic-ACP compatibility switches. `supportsMcpServers:
      // false` keeps configured MCP servers out of everything offered to
      // this agent — for implementations that reject requests carrying them.
      "params": { "supportsMcpServers": false },
      // Defaults to true. false is an explicit, reversible disable.
      "enabled": true
    }
  }
}
```

**Offline provisioning:** edit this file directly while the server is stopped
(or let config fan-out pick it up on the next mutation). On load, invalid
entries are dropped with a warning and every valid entry survives — a
hand-edited typo in one row cannot take the server down or drop the others.

## Live Mutation API

The local server exposes the registry under
`/api/claxedo/agent-config/harness/acp-connections`. The routes are gated the
same way as the rest of local harness configuration (local/self-hosted
deployments; hosted deployments that disallow local agent config refuse them).

| Method + path | Effect |
| --- | --- |
| `GET /harness/acp-connections` | Sanitized discovery rows: `{ connections: [{ key, id, label, access: "acp", enabled }] }`. **Never** includes `command` or `env`. |
| `PUT /harness/acp-connections/:id` | Upsert one connection. Body: `{ label, command, env?, params?, enabled? }`. |
| `DELETE /harness/acp-connections/:id` | Remove the connection. `404` if absent. |

Mutations are **atomic over the whole map**: the proposed result is validated
in full and rejected whole (`400` with a `problems` array naming each offending
id) if any entry is malformed. A failed mutation leaves the previously accepted
registry serving — running sessions and new selections are unaffected.

Every successful mutation fans the refreshed runtime snapshot out to connected
workspace runtimes, so an added or edited connection is selectable without a
restart.

## Selection And Discovery

The app's harness picker groups the **enabled** discovery rows under "ACP",
labeled with the server-provided `label`. Selecting one stores the canonical
key (`acp:<slug>`) — the browser never sees or sends the command or
environment. Disabled rows are not offered.

Programmatically, a connection is selected like any harness identity: the
string form `"acp:gemini"` or the object form `{ "id": "gemini", "access":
"acp" }` are both accepted wherever a harness identity is.

## Runtime Semantics

- **Fail-closed resolution.** A workspace runtime only starts processes for
  connections present in its **applied** registry (pushed through the trusted
  config-apply path, `POST /api/wr/config`). Selecting an identity that is
  unknown, disabled, or removed fails with
  `workspace_harness_not_configured` ("ACP connection … is not configured on
  this runtime") — it never falls back to a bundled first-party ACP binary or
  to OpenCode.
- **Process ownership.** The runtime spawns `command[0]` with the configured
  arguments verbatim (stdio transport). It does not resolve the executable
  against bundled binaries, and a missing or non-executable path surfaces as a
  spawn-time session error, not a silent substitution.
- **Environment is trusted-path-only.** `env` travels exclusively through the
  operator config → runtime snapshot → process spawn path. Session callers can
  never supply process environment, and discovery/status surfaces never echo
  it back.
- **MCP servers.** The user's configured MCP servers are offered to the agent
  through the ACP protocol's native `mcpServers` field (Claxedo-managed MCP
  servers remain a built-in-agent concern). `params.supportsMcpServers: false`
  withholds the offer entirely — session requests, process fingerprints, and
  process observation all see an empty server list — for agents that reject
  requests carrying MCP servers.
- **Enable / disable / remove.** `enabled: false` (or deletion) stops *new*
  execution immediately on the next applied snapshot; running turns finish.
  Stored sessions remain listed and their history stays readable; re-enabling
  the same slug restores execution for those sessions.
- **Id rebinding.** The slug is the identity. Deleting a slug and later
  re-adding it — even pointing at a different agent binary — rebinds all
  historical sessions under that slug to the new descriptor. Use a fresh slug
  when the new agent should not inherit the old history.

## Verifying A Connection

An integration suite exercises the full path against a scripted ACP process:
config mutation → sanitized discovery → session create → prompt turn streamed
from the configured process → atomic rejection of a malformed mutation →
disable failing closed → re-enable restoring the same logical identity and its
history. See
`packages/claxedo-server/src/tests/integration/agent-lifecycle.integration.test.ts`
("operator ACP connection lifecycle") and
`packages/workspace-runtime/src/workspace/runtime.test.ts`
("operator ACP connections") for the enforced behavior.

## Grounding

- Config schema + validation: `packages/claxedo-server-core/src/agent-config/index.ts`
  (`UserAcpConnection`, `normalizeAcpConnections`, `acpConnectionHarness`,
  `acpConnectionRows`, `getRuntimeConfigSnapshot`)
- Mutation API: `packages/claxedo-local-server/src/agent-config/routes/acp-connection-routes.ts`
- Identity rules: `packages/agent-sdk-runtime/src/harness-types.ts`
  (`ACP_CONNECTION_ID_PATTERN`, `isAcpConnectionId`, `harnessKey`)
- Runtime enforcement: `packages/workspace-runtime/src/workspace/runtime.ts`
  (`WorkspaceHarnessUnavailableError`), `packages/workspace-runtime/src/routes/config.ts`
