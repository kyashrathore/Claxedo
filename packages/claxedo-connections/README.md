# `@claxedo/connections`

Connections kit: link external accounts (Notion, Atlassian, GitHub, Google)
to a host application once, and let features consume them by **capability**
(`docs`, `work-source`, `channel`, `code-host`) instead of building their own
auth. One registry, one credential seam, one token path.

This is a **kit, not a service**: it reads no environment variables, holds no
module-global state, and implements no auth policy. Hosts supply storage
(two small ports), HTTP gates, and configuration.

## Quickstart (in-memory host)

```sh
npm install @claxedo/connections
```

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
for (const conn of await service.resolveForCapability("docs")) {
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

## `createTokenService` — the token path on its own

`createConnectionsService` is the whole flow (connect, verify, capability
resolution, removal). A host that wants only the last step — hand me a live,
usable token for this connection — uses `createTokenService` directly. It is
the single path that returns one, and the same path the full service uses
internally, so both get identical refresh and failure semantics.

```ts
import { ConnectionTokenError, createTokenService } from "@claxedo/connections"

const tokens = createTokenService({ registry, credentials })
try {
  const { token, tokenType, fields } = await tokens.getLiveToken(row)  // a ConnectionRow
} catch (error) {
  if (error instanceof ConnectionTokenError) {
    // HTTP-shaped: error.status (403 | 404 | 409 | 503), a closed error.code,
    // and error.credentialStatus when a credential was involved.
  }
}
```

It never caches: every call re-derives freshness from the stored credential.
API keys pass through unchanged; OAuth access tokens are refreshed shortly
before expiry, single-flight per credential per process. A definitive
`invalid_grant`-class rejection marks the credential `error` and stops serving
tokens until an explicit reconnect or `reverify`; transient failures persist
nothing and the next call retries. A non-vendored provider client signals the
definitive case by throwing `DefinitiveRefreshError` from `impl.refresh`.

[`docs/architecture.md`](docs/architecture.md) is the source of truth for the
exact refresh buffer, the single-flight mechanism, and the full failure
classification — consult it rather than restating those numbers here.

## Provider-call timeouts

Every reference impl bounds its provider calls at 10 seconds — `verify` and
`listRepositories` run inline on the connect path, so an unbounded provider
call there is an unbounded connect. Hosts override the ceiling per integration:

```ts
githubIntegration({ timeoutMs: 3_000 })      // also notion / linear / atlassian / google
```

`fetchImpl` is injectable on all five for tests and host-side instrumentation;
the deadline is applied around whatever fetch you supply, so a substituted
fetch cannot lose it.

## Signed connection webhooks

Team Connections with the `work-source` capability can own an independent
webhook signing credential. The host mounts the provider callback route and
passes each delivery to `createConnectionWebhookVerifier`; the callback URL
identifies the provider and the Connection, for example:

```text
https://<claxedo-host>/<host-webhook-prefix>/<provider>/<connection-id>
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
The consuming feature receives only a normalized delivery identity and routing
attributes, scoped to that team Connection.

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

### An impl that validates a field should persist what it validated

`verify` may return canonical values for declared non-secret fields, and the
service stores those instead of what the caller typed:

```ts
async verify(fields, secret) {
  const site = normalizeSiteUrl(fields.site_url ?? "")   // strict rule
  if (!site) return { ok: false, reason: "unauthorized" }
  // ... authenticate against `site` ...
  return { ok: true, fields: { site_url: site } }        // persist the origin
}
```

Do this whenever an impl derives a stricter or canonical form of a field.
Validating without persisting leaves the raw value in the row, and every later
consumer then has to re-derive the rule — which is how a weaker second
validator ends up deciding where credentials are sent. Returned values are
re-filtered through the declaration's non-secret prompts, so an impl cannot
introduce an undeclared key or shadow a secret prompt. `reverify` applies the
same canonicalization, so it repairs rows stored before an impl adopted this.

### Shared validation vectors

When a consumer must re-validate a stored value it received (because it, not
this kit, decides where credentials go), it should be pinned to the same rule.
`ATLASSIAN_SITE_URL_VECTORS` is exported for exactly that: a data-only array of
`{ input, expected, reason }` cases that both this package's tests and the
consumer's tests iterate.

```ts
import { ATLASSIAN_SITE_URL_VECTORS } from "@claxedo/connections"

it.each(ATLASSIAN_SITE_URL_VECTORS.map((v) => [v.input, v.expected, v.reason]))(
  "site_url contract: %j → %j (%s)",
  (input, expected) => { /* assert YOUR validator agrees */ },
)
```

Two implementations of one rule are only safe if a divergence fails a test.
That is not hypothetical — when these vectors were first run against both the
connect-time and request-time validators they disagreed on three inputs
(embedded credentials, a query string, a fragment), which one accepted and the
other refused.

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

### Adapter conformance

Both ports ship a runner-neutral conformance suite. Every case is a plain async
function, so a host registers them with whatever runner it already uses:

```ts
import { connectionStoreConformance, credentialStoreConformance } from "@claxedo/connections"

describe("my ConnectionStorePort", () => {
  connectionStoreConformance(async () => ({ store: createMyStore() })).forEach((c) => test(c.name, c.run))
})
```

The factory must yield an **empty** store per case. Connection conformance
version 2 pins the three-way `list({owner})` semantics (`undefined` = every
partition, `null` = the owner-absent team partition, string = that owner only),
`get(integrationId, owner)` partition isolation in both directions,
`getById` crossing partitions, full-row upsert round-trip with optionals kept
absent, in-place replacement by row id carrying the supplied timestamps,
same-integration rows in different partitions staying distinct, delete
semantics including partition isolation after deletion, and that all three
readers (`get`, `getById`, `list`) return copies — a caller mutating a returned
row must not be able to rewrite stored state without an `upsert`. Credential conformance
version 1 pins kind/status/expiry reporting, `resolveSecret` being
available-status-only against `readSecret` reading regardless of status,
provider-id isolation, status transitions, and `deleteByProvider` closing both
secret seams. No case asserts a secret's value — the secret-hiding cases assert
its **absence**. `CONNECTION_STORE_CONFORMANCE_SCOPE.remaining` names what is
deliberately unpinned and why.

Credential ids are always namespaced `integration:{connectionId}` so they never
collide with a host's other credentials. Secrets must live server-side; the
routes never echo them, and `verify` failures are a closed enum
(`unauthorized | network`) precisely so provider error bodies (which can
embed pasted secrets) never surface.

## Development

```sh
bun run typecheck && bun test src && bun run build
```

## See also

- [`docs/architecture.md`](docs/architecture.md) — the `CredentialStorePort` /
  `ConnectionStorePort` split, the connect/verify/attempt state machine, the
  token-refresh single-flight and failure semantics, and the per-provider
  webhook verification schemes.
