# `@claxedo/connections`

Link an external account (Notion, Atlassian, GitHub, Google, an MCP server) to
a host application once, and let features consume it by **capability** —
`code-host`, `docs`, `work-source`, `channel`, `mcp` — instead of each feature
building its own auth. One registry, one credential seam, one token path.

This is a **kit, not a service**. It reads no environment variables, holds no
module-global state, and implements no auth policy. The host supplies storage
(two small ports), HTTP gates, and configuration; the kit supplies mechanism.

This file is the whole reference: what it is, how it works, and what it
refuses to do.

---

## Quickstart

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

// Mount under your app with YOUR gates — `gate` is required, the kit ships
// no implicit allow-all (pass `() => null` to state an open policy).
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

OAuth is host-configured; the kit reads no env:

```ts
const google = googleIntegration({
  clientId: process.env.GOOGLE_CLIENT_ID!,        // YOUR app registration
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: "https://your-host.example/api/integrations/callback",
  scopes: ["https://www.googleapis.com/auth/drive.file"],
})
registry.register(google.decl, google.impl)
```

---

## The model

A **connection** is an authenticated link to one external account, held as two
separate things: a non-secret row (who it is, what it may do) and a secret
behind a narrower port. Nothing in the kit hands a stored secret to a feature —
features receive a live token, per operation, and never cache it.

**Capabilities are frozen at connect time.** A connection records the set the
integration served when it was made; changing that set means reconnecting with
broader consent. There is no toggle API, because a toggle would let a grant
widen without the user ever being asked.

**Partitions are opaque to the kit.** A connection carries an optional `owner`
string. Absent owner is the *team* partition; a present owner is that subject's
personal partition. One connection per integration per partition; re-linking is
an explicit, confirmed replace. `list({ owner })` is three-way: `undefined`
means every partition, `null` means the team partition only, a string means that
owner only — so a host adapter can push scoping into its query layer rather than
filtering in memory.

**The token wire shape is frozen:** `{ token, tokenType: "bearer" | "basic",
fields? }`. No `expires_at` — a consumer asks per operation, so there is nothing
to expire in its hands.

---

## How it works

### A. Capability ports — a capability is what something serves

`IntegrationCapability` is `keyof CapabilityPorts`, derived from the port map in
[`src/ports/index.ts`](src/ports/index.ts). Adding a capability means adding a
port. There is no way to name one that nothing serves.

```ts
type CapabilityPorts = {
  "code-host": CodeHostPort     // action-served: names listRepositories()
  docs: DocsPort                // token-served: marker
  "work-source": WorkSourcePort // token-served: marker
  channel: ChannelPort          // token-served: marker
  mcp: McpPort                  // brokered: marker
}
```

Three shapes, for three real situations:

- **Token-served** (`docs`, `work-source`, `channel`) — the consumer spends a
  capability-scoped token against the provider itself. The integration
  contributes auth and nothing else, so the port is a marker.
- **Brokered** (`mcp`) — the operation schemas belong to the MCP server. The kit
  neither owns nor validates them, so there are no methods to count. The port
  must be declarable rather than inferred; a registry deriving capabilities from
  method names alone would resolve every brokered integration to nothing.
- **Action-served** (`code-host`) — the port names `listRepositories`, so
  declaring it without implementing it is a compile error.

Every port carries a `capability` discriminant, and that single member is the
one doing work. It makes ports non-interchangeable — `actions: { docs:
workSourcePort }` is a compile error, not a silently mislabelled grant — and it
gives the registry a value to re-check at runtime for a host registering from
JavaScript or from a value it parsed.

`A.1` **The registry derives the set**, in
[`src/registry.ts`](src/registry.ts):

```ts
registry.register(decl, impl)   // capabilities = capabilitiesOf(impl.actions)
```

`IntegrationDeclaration` has no `capabilities` field. An author has nowhere to
write one; it is read back off `RegisteredIntegration`. Registering an
integration whose `actions` serve nothing throws — such an integration could
never be resolved and every connection made to it would be inert, so the mistake
is named at registration rather than at the first failed call.

*Why this exists:* `capabilities: ["code-host"]` used to be an authored string
that nothing checked. A declaration could claim the capability with no
`listRepositories` behind it, resolve through `resolveForCapability`, and fail
only when a caller reached the missing method.

`A.2` **An impl has two halves**, and they change for unrelated reasons:

```ts
type IntegrationImpl = {
  auth?: AuthImpl                    // verify / authorize / callback / device / refresh
  actions: Partial<CapabilityPorts>  // what it serves
}
```

### B. Connecting — three paths into one row

`B.1` **Key method (synchronous)** —
`service.connect({ integrationId, owner?, fields, secret, confirmReplace? })`:

1. Reject `unknown_integration` unless the integration is registered for the
   `"key"` method with a `verify` impl.
2. If `(integrationId, owner)` already holds a connection and `confirmReplace`
   isn't `true`, reject `connection_exists`. Replacing is always explicit.
3. Strip `fields` down to the declaration's non-secret prompts, then call
   `impl.auth.verify(fields, secret)`.
4. `verify` returns a **closed** result: `{ ok: true, accountLabel?, fields? }`
   or `{ ok: false, reason: "unauthorized" | "network" }` — never a raw provider
   error body, because that body can embed the pasted secret.
5. `fields` on success carries canonical values for declared non-secret fields
   and **replaces what the caller typed** (see *An impl that validates a field
   should persist what it validated*, below). Returned values are re-filtered
   through the declaration's prompts, so an impl cannot introduce an undeclared
   key or shadow a secret prompt.
6. The row is upserted and the secret written as `kind: "api_key"`,
   `status: "available"`.

`B.2` **OAuth redirect (asynchronous, via attempts)** —
`service.connectOAuth({ integrationId, owner?, teamOwner?, confirmReplace? })`
creates an **attempt** keyed by an opaque `state`, and returns the provider
authorize URL plus that state as `attemptId`. `service.handleCallback(state,
code)` consumes the attempt, calls `impl.auth.callback(code, verifier)`, stores
the connection as `kind: "oauth_token"`, and settles the attempt.

The attempt machine ([`src/attempts.ts`](src/attempts.ts)) is a plain `Map`, not
a store port — ephemeral by design. A host restart mid-flow drops pending
attempts and the callback hits the unknown-state rejection, sending the user
through a seconds-long, user-initiated retry rather than requiring durable
storage for a transient handshake.

```
create() ──> pending ──consume()──> (in flight, completing=true)
                │                          │
                │ sweep(): expiresAt<=now  │ settle(ok)
                ▼                          ▼
             expired                complete | failed
                │                          │
                └──────── removeAt<=now ───┘
                                │
                             (deleted)
```

- `create` mints `state` and a PKCE verifier (both
  `randomBytes(32).toString("base64url")`) and stamps
  `expiresAt = now + ttlMs` (default **10 minutes**).
- `consume(state)` is the only read of a pending payload and is atomic: it flips
  a `completing` flag, so a doubled callback gets `undefined` instead of racing
  the first. Unknown, expired, terminal, and already-completing states all
  return `undefined`, and `GET /callback` renders the same "Connection failed"
  page for every one of them.
- `settle(state, ok, message?)` stamps `removeAt = now + retentionMs`
  (default **5 minutes**) so `GET /attempts/:state` can still answer for a short
  window — that is what lets a UI poll for the outcome of a redirect it isn't
  handling itself.
- `sweep()` runs on an unref'd 30s interval, expiring stale pending entries and
  deleting terminal ones. It never touches an entry mid-`consume`.

The row's owner travels with the attempt from `create` to storage, so the
connection lands in the partition the flow started in even though the provider
round-trip is stateless from the kit's point of view.

`B.3` **OAuth device grant (RFC 8628)** — the same `connectOAuth` entry point,
taken when the impl supplies `auth.device` instead of (or as well as) the
redirect pair. The user reads a code off one screen and types it into another,
so nothing needs to reach a callback URL — which is what makes it the only OAuth
shape available to a desktop app or a self-hoster behind NAT. **Polling
`GET /attempts/:state` is what advances the grant**: there is no callback to
settle it. `DevicePoll` keeps `denied` and `expired` distinct because only one
of them is worth restarting automatically.

`B.4` **Re-verification** — `service.reverify(id)` is the third path into
`verify` and the recovery path for a credential parked in `"error"`. It reads
the secret with `readSecret` (bypassing the available-only gate), re-runs
`verify(row.fields, secret)`, and **only on success** clears the status back to
`"available"`. A failed reverify leaves the credential exactly as errored as it
was; there is no partial-recovery state. It applies the same canonicalization as
connect, which makes it the repair path for rows stored before an impl adopted
it.

### C. The storage seam — two ports, deliberately split

The kit never touches storage. `createConnectionsService` takes two
host-implemented ports, both in [`src/types.ts`](src/types.ts):

```ts
type ConnectionStorePort = {
  upsert(row): Promise<void>                       // keyed by row.id
  get(integrationId, owner?): Promise<Row | undefined>
  getById(id): Promise<Row | undefined>
  // undefined = every partition, null = team only, string = that owner only.
  list(filter?: { owner?: string | null }): Promise<Row[]>
  delete(id): Promise<boolean>
}

type CredentialStorePort = {
  put({ providerId, kind, secret, expiresAt? }): Promise<void>
  get(providerId): Promise<{ kind; status; expiresAt? } | undefined>
  resolveSecret(providerId): Promise<string | null>   // available-status ONLY
  readSecret(providerId): Promise<string | null>      // any status (re-verify)
  setStatus(providerId, "available" | "error", lastError?): Promise<void>
  deleteByProvider(providerId): Promise<void>
}
```

`ConnectionStorePort` owns the non-secret row: `id`, `integrationId`, `owner`,
`accountLabel`, `grantedCapabilities`, `fields`, timestamps. Nothing in it is a
secret, so a host can put it in its primary database and list, search, and join
freely.

`CredentialStorePort` owns the one thing the other never sees, keyed by the
namespaced `connectionProviderId(connectionId)` = `` `integration:${id}` ``.
**The two read paths are not interchangeable:**

- `resolveSecret` returns the secret only when the credential's status is
  `"available"`, and it is the **only** read the live-token path performs. A
  credential parked in `"error"` therefore cannot leak a stale secret through
  the token endpoint.
- `readSecret` returns the stored secret regardless of status, and **only**
  `reverify` calls it — re-verification is precisely the flow that must read a
  secret currently marked bad. A read must never repair status.

Splitting this way lets a host route credentials through a narrower, audited
secret store without the kit knowing the two live in different systems. The
in-memory implementations (`createMemoryCredentialStore`,
`createMemoryConnectionStore`) are for tests and examples, not durable use.

`upsert` carries a database invariant as a port contract: the id is the key and
`(integrationId, owner)` is unique, so a write naming a **new** id for a
partition that already holds a row for that integration is refused with
`ConnectionExistsError` (routes map it to 409). Both alternatives corrupt —
keeping both rows makes `get(integrationId, owner)` pick an arbitrary winner;
rewriting under the old id discards the supplied id, so `getById` misses after a
successful upsert and the credential written under the supplied id is stranded.
`createdAt`/`updatedAt` are the caller's: the service owns the clock, and a
store stamping its own would disagree with what it was told.

A host adapter whose secret seam is unavailable (a fail-closed hosted stub)
throws `ConnectionsUnavailableError` from any credential method; the token path
and routes map it to **503** `{ code: "connections_unavailable" }` rather than
treating it as a missing or errored credential.

### D. The token path — the only way a live token exists

`createTokenService` ([`src/tokens.ts`](src/tokens.ts)) is the single path that
returns a usable token, and the same path the full service uses internally, so
both get identical refresh and failure semantics. A host that wants only this
step can use it directly:

```ts
import { ConnectionTokenError, createTokenService } from "@claxedo/connections"

const tokens = createTokenService({ registry, credentials })
try {
  const { token, tokenType, fields } = await tokens.getLiveToken(row)
} catch (error) {
  if (error instanceof ConnectionTokenError) {
    // HTTP-shaped: error.status (403 | 404 | 409 | 503), a closed error.code,
    // and error.credentialStatus when a credential was involved.
  }
}
```

It never caches — every call re-derives freshness from the stored credential.

- **API keys** pass through unchanged; `resolveSecret` is the deciding read and
  the response is `{ token, tokenType: decl.keyTokenType, fields? }`. There is
  no refresh concept, so a `null` secret or an unset `keyTokenType` fails closed
  with `connection_not_available`.
- **OAuth tokens** are stored as a JSON envelope `{ access, refresh? }` on the
  same secret string. A token is fresh when `expiresAt` is unset or more than
  `REFRESH_BUFFER_MS` (**5 minutes**) away; fresh tokens return immediately.

`D.1` **Single-flight refresh, per `providerId`, per process.** Callers arriving
while a refresh for that credential is already running await the same promise
instead of firing a second provider call — the common case for a fan-out of
concurrent requests against one connection. This is explicitly **not**
cross-process: two host processes can still race a refresh. The accepted risk is
the narrow crash window between a provider accepting a refresh and the store
write landing, and it self-heals — the next attempt either succeeds or fails
definitively and takes the reconnect path below, rather than corrupting state.

`D.2` **Every refresh failure is exactly one of two things:**

- **Definitive** — an `invalid_grant`-class rejection: `OAuth2RequestError` from
  the vendored `arctic` client, or `DefinitiveRefreshError` thrown by a
  userland `impl.auth.refresh` to signal the same for a non-vendored client.
  The credential is set to `"error"` and the call throws
  `ConnectionTokenError(409, "connection_not_available", "error")`. Because
  `resolveSecret` serves only `"available"`, this persists until an explicit
  `reverify` or a fresh connect. **There is no silent self-repair.**
- **Transient** — anything else (network failure, provider 5xx, timeout).
  Nothing is persisted; the call throws `ConnectionTokenError(503,
  "connection_refresh_transient")` and the next call retries from scratch.

A consumer that gets a definitive rejection *from the provider API itself*
(rather than from refresh) reports it with `conn.reportAuthFailure(reason)`,
which takes the same path.

### E. Capability resolution — what a feature actually calls

```ts
const handles = await service.resolveForCapability("docs", { owner?, teamOwner?, integration? })
```

It matches against the row's frozen `grantedCapabilities`, and where both a team
and a personal connection exist for the same integration, **personal wins**.
Each handle is a `CapabilityHandle`: `{ id, integrationId, scope, accountLabel,
fields, getToken(), reportAuthFailure(reason) }`. No secret ever appears on it.

`code-host` is the one capability with an action behind it today:
`GET /connections/:id/repositories` resolves the port off the impl and returns
`501 repository_listing_unsupported` when it isn't served — the port is the
authority, not a declaration string.

### F. Routes

`createIntegrationsRoutes(service, options)` returns a Hono app. Every route
states a policy where it is registered, and a route that reaches the app any
other way fails the composition — an unstated policy would read as "open" at
every deployment. The kit decides no auth policy itself, so an intentionally
open deployment states that with `gate: () => null`.

| Route | Policy | Purpose |
| --- | --- | --- |
| `GET /` | `authenticated` | List integrations and the caller's connections |
| `POST /:id/connect` | `team-write` | Key connect, or start an OAuth/device flow |
| `GET /callback` | `public` | OAuth redirect landing; renders success/failure |
| `GET /attempts/:state` | `authenticated` | Poll an attempt — **and advance a device grant** |
| `DELETE /connections/:id` | `team-write` | Remove a connection and purge its credentials |
| `POST /connections/:id/reverify` | `team-write` | Recover an errored credential |
| `GET /connections/:id/repositories` | `authenticated` | `code-host` listing |
| `POST /connections/:id/auth-failure` | `turn-credential` | Consumer-reported definitive rejection |
| `GET /connections/:id/token` | `turn-credential` | The live token |

`authenticated` runs `gate`; `turn-credential` runs `gate` then `tokenGate`;
`team-write` runs `gate` and hands the handler `teamWriteGate`, which it
applies once it knows whether the target is a team row. `public` is the
provider's browser redirect alone, which carries its own single-use `state`.
`ConnectionExistsError` is mapped to 409 by an `onError` handler rather than by
each route.

---

## Constraints

### Security invariants (do not weaken these)

- **`resolveSecret` is available-status-only and is the only reader on the token
  path.** `readSecret` is reverify-only. A read must never repair status.
- **No action ever receives a stored secret** — only a live, capability-checked
  token.
- **`VerifyResult` failures are a closed enum** (`unauthorized | network`), so a
  provider error body — which can echo a pasted secret — can never surface.
- **`owner` must originate from a host-minted, subject-bearing credential.** The
  kit treats it as opaque and does not authenticate it; a route that lets a
  caller name its own owner is a partition break.
- **No redirect URL is ever placed in an agent-visible transcript.** An
  authorize URL is a bearer-ish artifact of a pending grant.
- **Credential ids are always namespaced** `integration:{connectionId}`, so they
  cannot collide with a host's other credentials, and no route ever echoes a
  secret.
- **A connection row is written only after its credential is durable.** The two
  ports share no transaction, so the order is the pairing: `put`, read it back,
  then `upsert`. Nothing is undone on the way back — an interrupted write
  leaves at most a secret under an id no route can address, which is a far
  smaller defect than a row whose credential is missing, and which no
  compensating delete can be trusted to clear anyway.

### Non-goals (load-bearing)

- **No MCP/tool gateway.** The `mcp` capability records that a connection is
  brokered; agent exposure belongs to host domain tools.
- **No API middleware in the token path** — no retries, rate limiting, request
  proxying, or provider API wrappers. Tokens out; nothing else.
- **No webhook subscription management, no webhook verification, no UI.** Hosts
  own all three.
- **No multiple accounts within one integration/owner partition.** Independent
  team and personal partitions are supported; two accounts in the same partition
  are not.
- **No cross-process refresh coordination.** Single-flight is per process, by
  design (see `D.1`).

### Provider-call timeouts

Every reference impl bounds its provider calls at 10 seconds. `verify` and
`listRepositories` run inline on the connect path, so an unbounded provider call
there is an unbounded connect. Hosts override per integration:

```ts
githubIntegration({ timeoutMs: 3_000 })      // also notion / linear / atlassian / google
```

`fetchImpl` is injectable on all five for tests and host instrumentation; the
deadline wraps whatever fetch you supply, so a substituted fetch cannot lose it.

### Reference integrations and extension policy

The package ships **reference implementations only**: Notion, Atlassian, GitHub
(key paste + verify, plus device grant when a client id is configured), Linear,
and Google (OAuth via a small vendored, MIT OAuth client — see
`vendor/arctic/LICENSE-NOTICE.md` in the published `dist/`, or
`src/vendor/arctic/LICENSE-NOTICE.md` in the repo). The Atlassian integration
accepts only `https://<site>.atlassian.net` (Atlassian Cloud); register your own
impl for self-hosted Data Center.

**Additional providers belong in your code**, registered with
`registry.register(decl, impl)` — an impl is at most a few small functions plus
the ports it serves. This package does not accept provider-implementation PRs as
a maintenance commitment; that treadmill is how OAuth libraries die.

#### An impl that validates a field should persist what it validated

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
consumer then re-derives the rule — which is how a weaker second validator ends
up deciding where credentials are sent. Atlassian is the case that forced it.

#### Shared validation vectors

When a consumer must re-validate a stored value it received (because it, not the
kit, decides where credentials go), pin it to the same rule.
`ATLASSIAN_SITE_URL_VECTORS` is exported for exactly that: a data-only array of
`{ input, expected, reason }` cases both sides iterate.

```ts
import { ATLASSIAN_SITE_URL_VECTORS } from "@claxedo/connections"

it.each(ATLASSIAN_SITE_URL_VECTORS.map((v) => [v.input, v.expected, v.reason]))(
  "site_url contract: %j → %j (%s)",
  (input, expected) => { /* assert YOUR validator agrees */ },
)
```

Two implementations of one rule are only safe if a divergence fails a test. That
is not hypothetical — run against both the connect-time and request-time
validators, these vectors disagreed on three inputs (embedded credentials, a
query string, a fragment): one accepted what the other refused.

### Adapter conformance

Both store ports ship a runner-neutral conformance suite. Every case is a plain
async function, so a host registers them with whatever runner it already uses:

```ts
import { connectionStoreConformance, credentialStoreConformance } from "@claxedo/connections"

describe("my ConnectionStorePort", () => {
  connectionStoreConformance(async () => ({ store: createMyStore() })).forEach((c) => test(c.name, c.run))
})
```

The factory must yield an **empty** store per case.

Connection conformance **version 2** pins: the three-way `list({ owner })`
semantics; `get(integrationId, owner)` partition isolation in both directions;
`getById` crossing partitions; full-row upsert round-trip with optionals kept
absent; in-place replacement by row id carrying the supplied timestamps;
same-integration rows in different partitions staying distinct; delete semantics
including partition isolation after deletion; and that all three readers return
**copies** — a caller mutating a returned row must not rewrite stored state
without an `upsert`.

Credential conformance **version 1** pins kind/status/expiry reporting,
`resolveSecret` being available-only against `readSecret` reading regardless of
status, provider-id isolation, status transitions, and `deleteByProvider`
closing both secret seams. No case asserts a secret's value — the secret-hiding
cases assert its **absence**. `CONNECTION_STORE_CONFORMANCE_SCOPE.remaining`
names what is deliberately unpinned, and why.

---

## Development

```sh
bun run typecheck && bun test src && bun run build
```

Ports carry negative type-level assertions in
[`src/ports/ports.test.ts`](src/ports/ports.test.ts): a missing `listRepositories`,
a mislabelled `{ docs: workSourcePort }`, and an invented capability key are all
pinned with `@ts-expect-error`, so the compile-time half of the port model fails
a test if it ever stops holding.
