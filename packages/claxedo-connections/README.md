# `@claxedo/connections`

Connections kit: link external accounts (Notion, Atlassian, GitHub, Google)
to a host application once, and let features consume them by **capability**
(`docs`, `work-source`, `channel`, `code-host`) instead of building their own
auth. One registry, one credential seam, one token path.

This is a **kit, not a service**: it reads no environment variables, holds no
module-global state, and implements no auth policy. Hosts supply storage
(two small ports), HTTP gates, and configuration.

## Quickstart (in-memory host)

```ts
import { randomUUID } from "node:crypto"
import {
  createIntegrationRegistry, createConnectionsService, createIntegrationsRoutes,
  createMemoryCredentialStore, createMemoryConnectionStore,
  notionIntegration, atlassianIntegration, githubIntegration,
} from "@claxedo/connections"

const registry = createIntegrationRegistry()
for (const ref of [notionIntegration(), atlassianIntegration(), githubIntegration()]) {
  registry.register(ref.decl, ref.impl)
}

const service = createConnectionsService({
  registry,
  credentials: createMemoryCredentialStore(),   // implement CredentialStorePort for real storage
  connections: createMemoryConnectionStore(),   // implement ConnectionStorePort for real storage
  newId: randomUUID,                            // host-owned row identity
})

// Mount under your app with YOUR gates — the kit enforces no auth policy.
app.route("/api/integrations", createIntegrationsRoutes(service, {
  gate: async (c) => (await myAuth(c)) ? null : c.json({ error: "forbidden" }, 403),
  tokenGate: async (c) => c.req.header("x-my-app") ? null : c.json({ error: "forbidden" }, 403),
}))

// Consumers ask by capability — never by provider, never touching secrets:
for (const conn of await service.forCapability("docs")) {
  const { token, tokenType, fields } = await conn.getToken()
  // ... call the provider API; on a definitive 401/403:
  // await conn.reportAuthFailure("401 from provider")
}
```

OAuth (Google) is host-configured — the kit reads no env:

```ts
registry.register(...Object.values(googleIntegration({
  clientId: process.env.GOOGLE_CLIENT_ID!,        // YOUR app registration
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: "https://your-host.example/api/integrations/callback",
  scopes: ["https://www.googleapis.com/auth/drive.file"],
})) as [any, any])
```

## Model

- A **connection** is an authenticated link to an external account. Hosts can
  partition connections with an opaque owner key: an absent owner is the team
  partition and a present owner is a host-defined personal partition. Each
  partition has one connection per integration (an explicit replace flow
  handles re-linking).
- **Capabilities are granted at connect time**, derived from what the
  credential actually covers; changing grants = reconnect with broader
  consent. There is no toggle API.
- The token wire shape is frozen: `{ token, tokenType: "bearer"|"basic",
  fields? }`. Consumers request a token per operation and never cache.
- Failure semantics: a definitive provider rejection (`invalid_grant`-class)
  marks the credential `error` and the connection stops serving tokens until
  the user reconnects or re-verifies; transient failures change nothing and
  the next call retries. Refresh is single-flight per credential,
  per-process.

## Signed WorkGraph webhooks

Team Connections with the `work-source` capability can own an independent
webhook signing credential. The provider callback URL is:

```text
https://<claxedo-host>/api/workgraph/webhooks/<provider>/<connection-id>
```

Store or rotate the signing value through the authenticated team-Connection
management route. The response never contains the value:

```http
PUT /api/claxedo/integrations/connections/<connection-id>/webhook-secret
Content-Type: application/json

{"secret":"<provider webhook signing secret>"}
```

Provider setup:

- **GitHub:** use `<provider> = github`, configure the same secret on the
  repository or organization webhook, and subscribe to issue events.
- **Linear:** use `<provider> = linear`. Create the webhook in Linear API
  settings with the callback URL above, subscribe to Issue events, then copy
  the signing secret from the webhook detail page into the Connection route.
  Claxedo verifies `Linear-Signature` over the raw body, requires
  `Linear-Delivery` and `Linear-Event`, and enforces Linear's one-minute
  `webhookTimestamp` replay window.
- **Jira Cloud:** use `<provider> = jira`. Create an admin/REST webhook with
  issue events, the callback URL above, and a high-entropy `secret`; store that
  same value in the Connection route. Claxedo verifies the raw-body
  `X-Hub-Signature` and deduplicates the retry-stable
  `X-Atlassian-Webhook-Identifier`.

Webhook bodies and signing credentials stay within the Connection verifier.
WorkGraph receives a normalized delivery identity and routing attributes, and
refreshes only active personal Source Views bound to that team Connection.

## Reference integrations & extension policy

The package ships **reference implementations only**: Notion, Atlassian,
GitHub (key-paste + verify) and Google (OAuth via a small vendored, MIT
OAuth client — see `vendor/arctic/LICENSE-NOTICE.md` in the published `dist/`,
or `src/vendor/arctic/LICENSE-NOTICE.md` in the repo). The Atlassian
integration only accepts `https://<site>.atlassian.net` site URLs (Atlassian
Cloud); register your own impl for self-hosted Data Center.

**Additional providers belong in YOUR code**, registered via
`registry.register(decl, impl)` — an impl is at most four small functions
(`verify` / `authorize` / `callback` / `refresh`). This package does not
accept provider-implementation PRs as a maintenance commitment; that
treadmill is how OAuth libraries die.

## Non-goals (load-bearing)

- **No MCP/tool gateway.** Agent exposure belongs to host domain tools.
- **No API middleware in the token path** — no retries, rate limiting,
  request proxying, or provider API wrappers. Tokens out; nothing else.
- **No webhook subscription management. No UI.** Hosts own both.
- **No multiple accounts within one integration/owner partition.** Hosts can
  create independent team and personal partitions, while multiple accounts in
  the same partition remain out of scope.

## Ports

```ts
type CredentialStorePort = {
  put({ providerId, kind, secret, expiresAt? }): Promise<void>
  get(providerId): Promise<{ kind; status; expiresAt? } | undefined>
  resolveSecret(providerId): Promise<string | null>   // available-status only
  readSecret(providerId): Promise<string | null>      // any status (re-verify)
  setStatus(providerId, "available" | "error", lastError?): Promise<void>
  deleteByProvider(providerId): Promise<void>
}
type ConnectionStorePort = {
  upsert(row); get(integrationId, owner?); getById(id); delete(id)
  // `undefined` = all partitions, `null` = team only, string = one owner.
  list({ owner? })
}
```

Credential ids are always namespaced `integration:{connectionId}` so they never
collide with a host's other credentials. Secrets must live server-side; the
routes never echo them, and `verify` failures are a closed enum
(`unauthorized | network`) precisely so provider error bodies (which can
embed pasted secrets) never surface.

## Development

```sh
bun run typecheck && bun test src && bun run build
```
