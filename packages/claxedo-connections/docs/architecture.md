# Architecture

This is the mechanism reference for `@claxedo/connections`: the two storage
ports, the connect/verify/attempt state machine, the token-refresh path, and
the per-provider webhook verification schemes. Start with the [README](../README.md)
for the model and quickstart; this doc is for hosts implementing the ports or
reasoning about failure semantics.

## The `CredentialStorePort` / `ConnectionStorePort` split

The kit never touches storage directly — `createConnectionsService` takes two
host-implemented ports, both defined in `src/types.ts`:

```ts
import type { CredentialStorePort, ConnectionStorePort } from "@claxedo/connections"
```

**`ConnectionStorePort`** owns the non-secret connection row: `id`,
`integrationId`, `owner` (partition key), `accountLabel`, `grantedCapabilities`,
`fields`, timestamps. It is a plain CRUD-ish port (`upsert` / `get` /
`getById` / `list` / `delete`) keyed by `(integrationId, owner)` for lookup
and by `id` for everything else. `list({ owner })` uses a three-way filter —
`undefined` returns every partition, `null` only the owner-absent team
partition, and a string only that opaque owner's partition — so a host's
adapter can push partition scoping down to its query layer instead of
filtering in memory.

**`CredentialStorePort`** owns the one thing `ConnectionStorePort` never
sees: the secret. It is keyed by `providerId`, always the namespaced form
`connectionProviderId(connectionId)` = `` `integration:${connectionId}` ``
(and, for webhook signing material, `connectionWebhookSigningProviderId`,
which appends `:webhook-signing` so token and webhook-secret lifecycles never
share a row). The port exposes two read paths on purpose:

- `resolveSecret(providerId)` — returns the secret only when the credential's
  status is `"available"`. This is the only path the live-token flow
  (`src/tokens.ts`) calls, so a credential parked in `"error"` cannot leak a
  stale secret through the token endpoint.
- `readSecret(providerId)` — returns the stored secret regardless of status.
  Only `reverify` (see below) calls this, because re-verification is exactly
  the flow that needs to read a secret that is currently marked bad.

Splitting storage this way means a host can put connection rows in its
primary database (list/search/join freely — nothing there is a secret) while
routing credentials through a narrower, audited secret store, without the
kit knowing or caring that the two live in different systems. The in-memory
reference implementations of both ports (`createMemoryCredentialStore`,
`createMemoryConnectionStore` in `src/stores/memory.ts`) are for tests and
examples, not durable use.

A host adapter whose secret seam is unavailable (a fail-closed hosted stub,
for example) throws `ConnectionsUnavailableError` from any `CredentialStorePort`
method; `src/tokens.ts` and `src/routes.ts` catch it and map it to a `503`
with `{ code: "connections_unavailable" }` rather than treating it as a
missing or errored credential.

## The connect / verify / attempt state machine

Key-method and OAuth-method integrations share one connection row shape but
take different paths to get there — both implemented in `src/service.ts` and,
for OAuth, backed by the attempt machine in `src/attempts.ts`.

### Key method (synchronous)

`service.connect({ integrationId, owner?, fields, secret, confirmReplace? })`:

1. Look up the integration; reject `unknown_integration` if it isn't
   registered for the `"key"` method or has no `verify` impl.
2. If a connection already exists for `(integrationId, owner)` and
   `confirmReplace` isn't `true`, reject `connection_exists` — replacing a
   connection is always an explicit, confirmed action, never implicit.
3. Strip the fields down to the integration's declared *non-secret* prompts
   (`declaredNonSecretFields`) and call `impl.verify(fields, secret)`.
4. `verify` returns a closed result: `{ ok: true, accountLabel?, fields? }` or
   `{ ok: false, reason: "unauthorized" | "network" }` — never a raw provider
   error body, because that body can embed the pasted secret.
5. `fields` on a successful result carries **canonical values for declared
   non-secret fields**, and they replace what the caller typed. An impl that
   derives a stricter form of a field must return it, so the strict rule becomes
   the stored invariant rather than a check that ran once and was discarded.
   Atlassian is the motivating case: it normalizes `site_url` to a strict
   `https://<site>.atlassian.net` origin, and returning that origin is what stops
   downstream consumers from re-deriving the rule (one of them did, more weakly,
   and it was the validator actually gating where Basic credentials were sent).
   Returned values pass through `declaredNonSecretFields` again, so an impl
   cannot add an undeclared key or shadow a secret prompt.
6. On success, `storeConnection` upserts the row and writes the secret to
   `CredentialStorePort.put(...)` as `kind: "api_key"`, `status: "available"`.

`reverify` applies the same canonicalization and writes the row back only when
the canonical form differs, which makes it the repair path for rows stored
before an impl adopted this.

### OAuth method (asynchronous, via `Attempts`)

`service.connectOAuth({ integrationId, owner?, teamOwner?, confirmReplace? })`
creates an **attempt** — a short-lived, in-memory row keyed by an opaque
`state` — and returns the provider authorize URL plus that `state` as
`attemptId`. The attempt machine (`createAttempts` in `src/attempts.ts`) is a
plain `Map`, not a store port: it's ephemeral by design, so a host restart
mid-flow drops pending attempts and the callback simply hits the
unknown-state rejection, sending the user back through a seconds-long,
user-initiated retry rather than needing durable storage for a transient
handshake.

An attempt moves through these states:

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

- **`create(...)`** generates `state` and a PKCE-style `verifier`
  (both `randomBytes(32).toString("base64url")`), stores a `pending` entry
  with `expiresAt = now + ttlMs` (default 10 minutes), and returns both to
  the caller. `service.connectOAuth` hands `state`/`verifier` to
  `impl.authorize(state, verifier)` to build the provider redirect URL.
- **`consume(state)`** is the only way to read a pending attempt's payload,
  and it is atomic: it flips a `completing` flag on the entry so a second
  concurrent consume (e.g. a doubled callback request) gets `undefined`
  instead of racing the first. It also self-transitions an entry to
  `expired` and returns `undefined` if `expiresAt` has already passed.
  Unknown states, already-terminal states, and already-completing states all
  return `undefined` — the callback route (`GET /callback` in
  `src/routes.ts`) treats every `undefined` the same way: render the
  "Connection failed" page.
- **`settle(state, ok, message?)`** transitions a still-pending entry to
  `complete` or `failed`, stamping `removeAt = now + retentionMs` (default 5
  minutes) so `status(state)` (used by `GET /attempts/:state`) can still
  answer for a short window after the flow finishes — this is what lets a UI
  poll for the outcome of a redirect it isn't itself handling.
- **`sweep()`** runs on an unref'd interval (default 30s) and does two
  things: expires pending entries past `expiresAt` that are not mid-`consume`,
  and deletes terminal entries past `removeAt`. It never touches an entry
  that's mid-`consume` (`completing: true`) until `settle` moves it to a
  terminal state.

`service.handleCallback(state, code)` is the consumer: it calls
`attempts.consume(state)`, and if that yields a pending entry, calls
`impl.callback(code, verifier)` to exchange the code for tokens, stores the
resulting connection (`kind: "oauth_token"`), and calls
`attempts.settle(state, true)`. Any failure — unsupported callback, a thrown
exchange error — calls `attempts.settle(state, false, message)` instead. The
row's `owner`/`scope` travel with the attempt from `create` through to
`storeConnection`, so the eventual connection lands in the same partition the
flow was started in even though the provider round-trip is stateless from
the kit's point of view.

### Re-verification

`service.reverify(id)` is the third path into `verify`, used to recover a
connection whose credential is currently `"error"`: it reads the secret with
`readSecret` (bypassing the `"available"`-only gate `resolveSecret` enforces),
re-runs `impl.verify(row.fields, secret)`, and — only on success — calls
`credentials.setStatus(providerId, "available")` to clear the error. A failed
reverify leaves the credential exactly as errored as it was; there's no
partial-recovery state.

## Token refresh: single-flight and failure semantics

`createTokenService` (`src/tokens.ts`) is the only path that returns a live,
usable token, via `getLiveToken(row)`. It never caches: every call re-derives
freshness from the stored credential.

- **API keys** pass through unchanged: `resolveSecret` is the deciding read,
  and the response is `{ token, tokenType: decl.keyTokenType, fields? }`.
  A key credential has no refresh concept — if `resolveSecret` returns
  `null` or `decl.keyTokenType` is unset, the call fails closed with
  `connection_not_available`.
- **OAuth tokens** are stored as a JSON envelope, `{ access, refresh? }`, on
  the same secret string. `getLiveToken` parses it, and treats the token as
  fresh when `credential.expiresAt` is unset or more than
  `REFRESH_BUFFER_MS` (5 minutes) away. Fresh tokens return immediately.

When a refresh is needed, `getLiveToken` joins or starts a single in-flight
refresh **per `providerId`, per process** — a `Map<string, Promise<void>>`
keyed by the credential's provider id:

```ts
const pending = inflight.get(providerId)
  ?? inflight.set(providerId, refreshOnce(...).finally(() => inflight.delete(providerId))).get(providerId)!
await pending
```

Every caller that arrives while a refresh for that credential is already
running awaits the same promise instead of firing a second provider refresh
call — the common case for a fan-out of concurrent requests against one
connection. This is explicitly **not** cross-process: two host processes can
still race a refresh against the same credential. The accepted risk is a
narrow one — the crash window between a provider accepting a refresh and the
store write landing — and it self-heals, because the next refresh attempt
either succeeds outright or fails definitively and takes the reconnect path
below, rather than silently corrupting state.

`refreshOnce` classifies every failure into exactly one of two outcomes:

- **Definitive** — the vendored client raised `OAuth2RequestError` (an
  `invalid_grant`-class rejection from the vendored `arctic` OAuth client, see
  `src/vendor/arctic/`), or a userland `impl.refresh` threw
  `DefinitiveRefreshError` to signal the same thing for a non-vendored
  provider client. Both call `credentials.setStatus(providerId, "error",
  "refresh_failed")` and throw `ConnectionTokenError(409,
  "connection_not_available", "error")`. Because `resolveSecret` only serves
  `"available"` credentials, this status persists until an explicit
  `reverify` or a fresh connect — there is no silent self-repair from an
  `"error"` status.
- **Transient** — anything else (network failure, provider 5xx, timeout).
  Nothing is persisted; `getLiveToken` throws
  `ConnectionTokenError(503, "connection_refresh_transient")` and the next
  call to `getLiveToken` simply retries the refresh from scratch.

```ts
import { ConnectionTokenError, DefinitiveRefreshError, createTokenService } from "@claxedo/connections"
```

`ConnectionTokenError` carries an HTTP-shaped `status` (`403 | 404 | 409 |
503`), a closed `code`, and an optional `credentialStatus` — `src/routes.ts`
maps it straight onto the token endpoint's response without any translation
layer in between.

## Per-provider webhook verification

Team connections with the `work-source` capability can carry an independent
webhook-signing credential (`connectionWebhookSigningProviderId`, stored and
rotated only through `PUT /connections/:id/webhook-secret`, which never
echoes the value back — see the [README](../README.md#signed-connection-webhooks)).
Verification of an inbound delivery is a separate concern, implemented in
`src/webhooks.ts` and composed with `createConnectionWebhookVerifier`:

```ts
import {
  createConnectionWebhookVerifier,
  githubConnectionWebhookVerifier,
  linearConnectionWebhookVerifier,
  jiraConnectionWebhookVerifier,
} from "@claxedo/connections"

const verifier = createConnectionWebhookVerifier({
  resolve: async (connectionId) => {
    const secret = await service.resolveWebhookSigningSecret(connectionId, "github")
    return secret ? { provider: "github", secret } : undefined
  },
  providers: {
    github: githubConnectionWebhookVerifier(),
    linear: linearConnectionWebhookVerifier(),
    jira: jiraConnectionWebhookVerifier(),
  },
})

const signal = await verifier.verify({ connectionId, provider, headers, body, receivedAt: Date.now() })
```

`verifier.verify` first resolves the connection's `(provider, secret)` pair
and confirms the request's claimed `provider` matches it — a mismatch (or an
unresolvable connection) returns `undefined` before any per-provider
verifier runs. It then dispatches to the matching per-provider scheme, all
of which share one HMAC primitive (`verifySha256`, WebCrypto
`crypto.subtle.verify` over the raw body — never a body that has been
JSON-parsed and re-serialized, since re-serialization is not guaranteed
byte-identical to what was signed):

- **GitHub** (`githubConnectionWebhookVerifier`) — requires
  `x-hub-signature-256` (a `sha256=`-prefixed hex HMAC), `x-github-delivery`,
  and `x-github-event`. On success it extracts `repo` (`repository.full_name`),
  `state` (`issue.state`), and `labels` (issue label names) as attributes.
- **Linear** (`linearConnectionWebhookVerifier`) — requires
  `linear-signature`, `linear-delivery`, `linear-event`, and
  `linear-timestamp`, verifies the raw-body HMAC, and additionally enforces
  Linear's documented replay window: the header timestamp must equal the
  body's `webhookTimestamp` and both must be within `maxAgeMs` (default one
  minute) of `receivedAt`. Attributes include `team` (deduped from
  `teamId`/`team.id`/`team.key`/the identifier prefix), `organization`, and
  `issue`.
- **Jira Cloud** (`jiraConnectionWebhookVerifier`) — requires a
  `sha256=`-prefixed `x-hub-signature` and the retry-stable
  `x-atlassian-webhook-identifier` (used as `deliveryId` so retried
  deliveries dedupe cleanly downstream). Attributes include `project`
  (deduped from the issue's project id/key/name plus any project-field
  changelog entries — a Jira move-between-projects edit surfaces the old and
  new project there), `issue`, and `issueKey`.

Every scheme returns the same shape,
`{ deliveryId, event, attributes }` — attributes are always
`Record<string, string | readonly string[]>`, so a consumer never has to
branch on which provider produced a signal. The provider bodies and the
signing secret itself never leave `src/webhooks.ts`: only
`VerifiedConnectionWebhookSignal` (adding back `connectionId`, `provider`,
`receivedAt`) crosses into the caller.
