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

- A **connection** is an authenticated link to an external account. One
  connection per integration per host (an explicit replace flow handles
  re-linking).
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
- **No multi-account per integration** (yet — requires a by-id secret
  resolver on the credential port).

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
  upsert(row); get(id); list(); delete(id)
}
```

Credential ids are always namespaced `integration:{id}` so they never
collide with a host's other credentials. Secrets must live server-side; the
routes never echo them, and `verify` failures are a closed enum
(`unauthorized | network`) precisely so provider error bodies (which can
embed pasted secrets) never surface.

## Development

```sh
bun run typecheck && bun test src && bun run build
```
