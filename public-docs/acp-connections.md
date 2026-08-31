# Agent Connections

Claxedo registers external agents through provider-owned connections. ACP is one
possible provider; it is not a special route, identity format, or browser
configuration shape.

Connections are trusted operator configuration. The browser receives only a
sanitized discovery record and never receives provider keys, commands,
endpoints, environment variables, headers, secret references, or resolved
credentials.

## Trusted v3 configuration

Connections live in `~/.claxedo/user-agent-config.json` under the required v3
`connections` map. Each map key must exactly match its descriptor's immutable
`connectionId`.

```jsonc
{
  "version": 3,
  "mcp": {},
  "connections": {
    "team-agent": {
      "connectionId": "team-agent",
      "providerKey": "acp",
      "configRevision": 1,
      "enabled": true,
      "config": {
        "label": "Team agent",
        "connection": {
          "kind": "process",
          "command": "/opt/agents/team-agent",
          "args": ["--acp"]
        },
        "secretBindings": {
          "env": { "TEAM_AGENT_TOKEN": "token" }
        },
        "modelSelection": { "status": "optional" }
      },
      "secretRefs": {
        "token": "credentials/team-agent-token"
      }
    }
  },
  "defaultConnectionId": "team-agent"
}
```

`defaultConnectionId` is optional. Omitting it leaves agent selection
unresolved; file order never selects a connection. Changing trusted settings
requires a higher `configRevision`. A different provider or endpoint identity
requires a new `connectionId`.

ACP `secretBindings.env` (process connections) and
`secretBindings.headers` (HTTP/WebSocket connections) map a target variable or
header name to a provider secret name. That name must have a matching
`secretRefs` entry. The host resolves it immediately before adapter creation;
the descriptor and browser projection never contain the resolved value.

There is no v1/v2 decoder, ACP map importer, built-in OpenCode row, or fallback
connection.

## Authenticated local API

The local server exposes one generic route family under
`/api/claxedo/agent-config/connections`:

| Method + path | Effect |
| --- | --- |
| `GET /connections` | Returns `{ connections: HarnessConnectionRef[] }`. |
| `PUT /connections/:connectionId` | Atomically validates and stores one complete trusted descriptor. |
| `DELETE /connections/:connectionId` | Removes one connection and clears it as the explicit default, if selected. |

The removed `/harness/acp-connections` path has no alias.

The public `HarnessConnectionRef` contains only:

```ts
type HarnessConnectionRef = {
  connectionId: string
  label: string
  enabled: boolean
  readiness: "ready" | "unavailable" | "disabled"
  capabilities: {
    abort: boolean
    reconnect: boolean
    replay: boolean
    permissions: boolean
    questions: boolean
    todos: boolean
    commands: boolean
    fork: boolean
    revert: boolean
    unrevert: boolean
    configOptions: boolean
    subagents: boolean
  }
  modelSelection?:
    | { status: "required"; models: AgentModel[] }
    | { status: "optional"; models?: AgentModel[] }
    | { status: "unsupported" }
}
```

The Connections settings screen lists this projection and can remove a
connection. Provider-specific add/edit payloads remain an authenticated
operator action rather than a raw-secret browser form.

## Selection and model policy

Connection IDs are opaque. A client must not prefix, parse, or turn them into a
legacy ACP string. Runtime selection uses the discriminated target
`{ kind: "connection", connectionId }`; native selection uses
`{ kind: "native", harnessId }`.

The picker follows the advertised `modelSelection` policy:

- `required`: a model must be selected before submission.
- `optional`: model selection may be offered, but an empty model list does not
  block submission.
- `unsupported`: the agent owns model selection and the UI does not fabricate a
  model row.

Until a runtime endpoint accepts the discriminated target, the app must leave a
connection unselectable. It must not install a compatibility string encoding.

## Secret and lifecycle rules

- Secret references resolve on the host immediately before adapter creation.
- Public responses and logs expose only redacted typed failures.
- Disabled, unknown, unavailable, expired, revoked, or uninstalled connections
  fail closed without falling back to another agent.
- Config and secret-generation changes invalidate the prior adapter generation.
- Removing a connection prevents new execution while canonical session history
  remains readable.

## Grounding

- Trusted descriptor and provider-owned public projection:
  `packages/agent-sdk-runtime/src/connection-provider.ts`
- Strict v3 persistence/map validation:
  `packages/claxedo-server-core/src/agent-config/connections.ts`
- Secret boundary:
  `packages/claxedo-server-core/src/agent-config/connection-secrets.ts`
- Generic CRUD route:
  `packages/claxedo-local-server/src/agent-config/routes/connection-routes.ts`
- Browser decoder/store:
  `packages/claxedo-app/src/features/settings/ui/agent-connections.ts`
