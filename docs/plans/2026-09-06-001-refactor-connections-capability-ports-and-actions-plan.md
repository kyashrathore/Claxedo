---
title: "refactor: connections capability ports, an action layer, and agent-initiated connect"
status: proposed; implementation not started
type: refactor
date: 2026-09-06
baseline: f02ad87fbe
package: packages/claxedo-connections
backward_compatibility: none — clean break, no legacy adapters, no migration shims
related: ../../packages/claxedo-connections/README.md
---

# refactor: connections capability ports, an action layer, and agent-initiated connect

## Overview

`@claxedo/connections` is a decision-free kit: it reads no env, holds no module-global state, and reaches a host only through two storage ports. That shape is correct and this plan does not change it. What this plan changes is everything the kit says *above* those ports.

Three things are wrong today, and they are the same defect seen from three angles:

1. **A capability is a tag, not a contract.** `"docs"` names no methods, so two `docs` providers share a word and nothing else, and every consumer branches on `integrationId` anyway.
2. **The one action that exists is bolted onto the universal impl interface.** `listRepositories` is an optional method on `IntegrationImpl` implemented by exactly one provider. The second action would be the second optional method, and the eighth would be the eighth.
3. **One connection per `(owner, integration)`.** A person may hold one Notion, one GitHub, one Google. The uniqueness index enforces it and `connect` returns `connection_exists`.

This plan makes the capability name a port that the impl must satisfy, moves actions into those ports behind one generic invoker, allows multiple accounts per provider, makes the granted capability set an explicit consent record rather than a copy of the declaration, and adds an agent-initiated connect path whose consent boundary is the RFC 8628 device code. It also closes the nine correctness and lifecycle gaps the units below enumerate.

The owner has stated there is **no backward compatibility requirement**. This is a clean break. Existing rows, existing route shapes, and existing exported types are all replaceable. No legacy adapter, no dual-read, no migration of stored rows, no deprecated re-export. New work uses the new contract; a row written by the old contract is not required to load.

This task produces a plan. Implementation has not started.

## Problem Frame

The kit currently conflates four distinct concerns under two names.

`IntegrationCapability` does two unrelated jobs. It is an **authorization grant** — [`getToken`](../../packages/claxedo-connections/src/service.ts#L205) refuses with `403 capability_not_granted` when the requested capability is absent from the row, which is a real containment boundary and is load-bearing. It is also a **selector** — [`resolveForCapability`](../../packages/claxedo-connections/src/service.ts#L244) answers "which connections can do docs?" The selector job is dead in production: all three live call sites pass `integration: request.integrationId` and then destructure `const [connection] =`, because `CapabilityRequest` makes `integrationId` required. The dedup is a `Map` keyed by `integrationId`, so with the integration pinned there is at most one survivor and the destructure is safe *by accident*. Called without `integration`, the same code returns several handles in `Map` insertion order and the first-element pattern picks arbitrarily.

`IntegrationImpl` conflates auth mechanism with provider actions. `verify`, `authorize`, `callback`, `device`, `refresh` are auth. `listRepositories` is a product action that happens to live next to them and takes a parameter named `secret` that actually receives a live access token from [service.ts:516](../../packages/claxedo-connections/src/service.ts#L516).

`grantedCapabilities` reads like a user grant but is populated as `[...decl.capabilities]` at [service.ts:154](../../packages/claxedo-connections/src/service.ts#L154) — a copy of what the provider advertised, frozen at connect. Freezing is right. Calling a provider's advertised shape a "grant" is not.

Separately, two hand-written `CredentialStorePort` adapters exist, one per host, and they have diverged: the SQLite one flips an errored credential back to `available` inside `readSecret`, so a failing re-verify leaves the token path serving a rejected credential. The hosted one does not. That divergence is the direct product of writing the adapter twice.

## Requirements Trace

### Capability as a contract
- A capability name resolves to a TypeScript port with named methods.
- An integration's declared capabilities are **derived** from the ports it implements, so a declaration cannot claim a capability it cannot serve.
- A consumer holding a capability handle can call the port's methods without knowing the `integrationId`.

### Actions
- Adding an action to a provider does not widen any universal interface.
- Every action receives a live, capability-checked token through the existing `getToken` path; no action ever receives a stored secret.
- Every action carries `destructive` metadata, and a destructive action cannot execute without an explicit approval decision.
- Only the actions the product requires are implemented. There is no obligation to mirror a provider's full API.

### Multiple accounts
- A person may hold several connections to the same provider (two Notion workspaces, a personal and a work GitHub).
- Resolution returns all of them; the caller selects.
- Every connection carries a stable provider-side account identity, not only a display label.

### Grants
- The granted capability set is chosen at connect time and may be narrower than what the provider offers.
- The grant is a consent record with a timestamp and the surface that captured it.

### Agent-initiated connect
- An agent may **propose** a connection; it may never complete one.
- The completing human is the connection's owner, and that owner is provably the person who entered the code.
- No redirect URL is ever placed in an agent-visible transcript.

### Correctness and lifecycle
- One `CredentialStorePort` implementation, used by both hosts.
- `readSecret` never writes status.
- `remove` makes a best-effort provider-side revocation.
- Both conformance suites run against every registered adapter, including D1.
- The conformance suites are proven to fail a deliberately broken adapter.

## Scope Boundaries

**In scope.** `packages/claxedo-connections` in full; the connections composition in `packages/claxedo-server/src/connections/**` including both host adapters; the call sites in `packages/claxedo-server/src/deployments/self-hosted-node/app.ts` and `packages/claxedo-server/src/agent-plugins/**` that consume capability resolution; the onboarding code-host consumer in `packages/claxedo-app/src/features/onboarding/**`.

**Not ours to build, at any point.** The **provider action corpus itself**. Coverage comes from MCP servers whose schemas their authors maintain; this plan builds the broker around them and hand-authors actions only under the three-part admission test in [Where action schemas come from](#where-action-schemas-come-from). A unit that grows the hand-authored action count beyond that test has misread this plan.

**Out of scope, deliberately.** The **corpus search/describe** surface and **code-mode sandbox execution** discussed alongside this work are not connections changes. The corpus is the agent-plugins catalog; code-mode belongs to `packages/sandbox-manager` and its egress policy. This plan builds the seam they would consume — a generic action invoker with destructiveness metadata and host-bound token minting — and stops there. Both are named in [System-Wide Impact](#system-wide-impact) so the interface is designed for them, not retrofitted.

Adopting a third-party integration platform (Nango, Composio, Executor) is out of scope and was rejected before this plan; the reasoning is restated under Rejected alternatives below and is unchanged.

## Context & Research

Findings below were read from the tree at baseline `f02ad87fbe`, not inferred.

### A. The selector role is unused
`resolveForCapability` has three production call sites, all in [hosted-d1/setup.ts](../../packages/claxedo-server/src/connections/hosted-d1/setup.ts#L301) at lines 301, 330, and 358. Every one passes `integration`. `CapabilityRequest` at line 280 makes `integrationId` required. No caller exercises cross-provider selection.

### B. One action already exists, and it works
[service.ts:501-516](../../packages/claxedo-connections/src/service.ts#L501-L516) calls `getToken(id, "code-host")` and then hands `token.response.token` to `impl.listRepositories`. The action therefore inherits the capability guard, the refresh buffer, the single-flight, and the definitive-versus-transient classification for free. This is the correct wiring; only the *shape* it is wired into is wrong.

### C. Uniqueness is enforced at the store
The D1 store carries a unique partition index and treats a unique failure as the only constraint its upsert can trip — see [connection-store.ts:72-78](../../packages/claxedo-server/src/connections/hosted-d1/connection-store.ts#L72-L78). `connect` returns `connection_exists` unless `confirmReplace` is passed. One connection per `(org, owner, integration)`.

### D. The gateway pattern is already built, for MCP
[runtime-preparation.ts:271-305](../../packages/claxedo-server/src/agent-plugins/mcp/runtime-preparation.ts#L271-L305) resolves by `capability: "mcp"`, mints a scoped token via `mintMcpGatewayToken` carrying user, org, project, workspace, harness, plugin instance and server name, and hands the harness a gateway URL plus an `Authorization` secret bound to `hosts: [endpoint.host]`. The provider token never reaches the agent. This is the reference implementation for action-layer token binding.

### E. Dynamic client registration exists
`McpOAuthDynamicRegistrationPort`, `clientIdMetadataDocumentUrl` and `preRegistered` are wired in [hosted-composition.ts:164-179](../../packages/claxedo-server/src/agent-plugins/hosted-composition.ts#L164-L179). Registering against a previously unknown issuer is a solved problem in this repo for MCP servers.

### F. The sandbox and its egress policy exist
[hosted-network-policy.ts](../../packages/sandbox-manager/src/hosted-network-policy.ts) is a name-based allowlist that runs unchanged inside the Worker, assembled from three named sources, and its header reasons explicitly about repository exfiltration. Any future code-mode work inherits this, and every new provider host becomes an explicit `extraHosts` decision.

### G. The webhook surface is unreachable
`createConnectionWebhookVerifier` and the three provider verifiers are exported from [index.ts](../../packages/claxedo-connections/src/index.ts) and tested, and [routes.ts:241](../../packages/claxedo-connections/src/routes.ts#L241) and `:262` store and delete signing material. A repository-wide search finds no non-test consumer in either host. Signing secrets can be written and are never read.

## Key Technical Decisions

1. **A capability names a port.** `IntegrationCapability` stops being a free-standing string union and becomes `keyof CapabilityPorts`. The union still has five members; the difference is that each member now implies methods.
2. **Declared capabilities are derived, never declared twice.** `decl.capabilities` is computed from the ports the impl satisfies — its action maps, plus any brokered port it declares. A declaration cannot lie, and a synthesized MCP integration derives `["mcp"]` rather than an empty set.
3. **Actions take an `ActionContext`, never a secret.** The context carries a live token, its type, the canonical fields, and the host's timeout-wrapped fetch seam. The current `(fields, secret: string)` signature is deleted, closing a naming trap where the parameter says "secret" and the value is a token.
4. **Destructiveness is structural.** Each action is declared with `destructive: boolean` in a manifest beside its port. The invoker refuses a destructive action without an approval decision, so approval cannot be forgotten at a call site.
5. **Coverage is brokered; authorship is rationed.** Breadth comes from MCP servers we do not maintain, using the discovery and dynamic-registration rail already proven by the signed Composio loop. Hand-written ports are a small normalization tier gated by a three-part admission test, not a corpus.
6. **Multiple accounts per provider.** The store key gains a stable `accountKey` derived from the provider's own account identity. `connection_exists` and `confirmReplace` are deleted.
7. **`resolveForCapability` keeps its selector role, and it becomes real.** Because the tag now implies methods, returning several handles is useful rather than a trap. `integration` becomes an optional narrowing filter, and the arbitrary `Map`-order tiebreak is replaced by a defined ordering.
8. **Agent-initiated connect is device-grant only.** An agent may call `proposeConnection`; it receives a user code and a verification URI, never an authorization URL. Providers without `impl.auth.device` are not available to agent-initiated connect.
9. **One credential adapter.** A single factory over `ControlPlaneCredentials` serves both hosts. The SQLite and hosted hand-written adapters are deleted.
10. **The webhook surface is deleted.** It stores secrets nothing reads. If push delivery is needed later it returns with a mounted route and an end-to-end signed-delivery test.

## Open Questions

### Resolved during planning
- *Should the capability tag be deleted outright, since callers pin `integrationId`?* No. The **guard** is load-bearing and correct. Deleting the tag would remove a real containment boundary to fix a naming problem. Making the tag imply methods fixes both.
- *Should the kit adopt a third-party integration platform?* No; unchanged. Custody of the refresh token and the local SQLite/Electron deployment are the two constraints none of them satisfy.
- *Should the agent be able to complete a connection?* No. OAuth requires a human at a browser, and an agent has no subject-bearing turn credential of its own, so an agent-minted connection lands owner-absent — the **team** partition. That would grant the whole organization standing access to a third-party service, which is precisely the failure the fail-safe invariant at [service.ts:233-243](../../packages/claxedo-connections/src/service.ts#L233-L243) exists to prevent.

### Deferred to implementation
- Whether `accountKey` is a provider-supplied id for every integration or a normalized hash where a provider exposes none.
- Whether the destructive-action approval decision reuses the existing WorkGraph approval gate or takes a caller-supplied token.
- Whether action input and output carry runtime schemas now, or only TypeScript types until the corpus work needs them.

## High-Level Technical Design

### The new contract

```ts
// A capability names a port. The union is derived from this map.
export type CapabilityPorts = {
  "code-host": CodeHostActions
  docs: DocsActions
  "work-source": WorkSourceActions
  channel: ChannelActions
  mcp: BrokeredPort         // brokered: schemas come from the server's tools/list, not from us
}
export type IntegrationCapability = keyof CapabilityPorts

// A brokered capability declares a broker, not an action map, so a synthesized
// MCP integration still derives `["mcp"]` rather than `[]`.
export type BrokeredPort = { brokered: true }

// What every action receives. Never a stored secret.
export type ActionContext = {
  token: string                 // live, refreshed, capability-checked
  tokenType: "bearer" | "basic"
  fields: ConnectionFields      // canonical, post-verify
  fetch: IntegrationFetch       // the host's timeout-wrapped seam
  signal?: AbortSignal
}

export type CodeHostActions = {
  listRepositories(ctx: ActionContext): Promise<CodeHostRepository[]>
}
export type DocsActions = {
  search(ctx: ActionContext, query: string): Promise<DocResult[]>
  fetch(ctx: ActionContext, id: string): Promise<DocContent>
}

// Destructiveness lives beside the port, not at the call site.
export type ActionManifest<P> = { [K in keyof P]: { destructive: boolean; summary: string } }

// Auth and actions separate.
export type IntegrationImpl = {
  auth: AuthImpl                                    // verify/authorize/callback/device/refresh/revoke
  canonicalFields?: readonly string[]
  actions: Partial<{ [K in IntegrationCapability]: CapabilityPorts[K] }>
}
```

`IntegrationDeclaration.capabilities` is no longer authored. The registry computes it from `Object.keys(impl.actions)` at registration.

### Where action schemas come from

**We do not author an action corpus, and this plan must not be read as proposing one.** Provider coverage comes from schemas other people maintain. There are three tiers, and only the smallest is ours.

**Tier 0 — brokered, via MCP. Schemas we author: zero.**
The provider, or an aggregator such as Composio, or a community maintainer, ships an MCP server. Its `tools/list` *is* the schema corpus, versioned and maintained by whoever ships it. This rail is already built and proven in-tree, not proposed here: [`mcpOAuthIntegrationId`](../../packages/claxedo-server-core/src/agent-plugins/mcp/integration.ts#L40) hashes `(pluginInstanceId, serverName)` into an integration id, [`mcpOAuthDeclaration`](../../packages/claxedo-server-core/src/agent-plugins/mcp/integration.ts#L46) synthesizes the declaration, and `createMcpOAuthIntegration` builds the whole OAuth impl from RFC 8414/9728 discovery plus RFC 7591 dynamic registration. Adding a provider adds no file. [`signed-composio.miniflare.test.ts`](../../packages/claxedo-server/src/agent-plugins/signed-composio.miniflare.test.ts) proves a signed-in Gmail loop through this rail on both a laptop runtime and a cloud VM. Destructiveness for these actions comes from the tool's own MCP `annotations.destructiveHint` / `readOnlyHint`, so that metadata is not ours to write either.

This tier is what makes "connect to any third-party service" true. It scales because the kit maintains the **broker** — credential custody, the capability guard, host-bound token minting — and never the corpus.

**Tier 1 — generated. Schemas we author: zero; specs we pin: one per provider.**
Where a provider publishes OpenAPI but ships no MCP server, generate a port from the spec at build time and pin the spec digest. We maintain a generator and a pin, not method signatures. Expect this tier to stay empty: for a missing provider the correct first move is to run its MCP server, not to generate a client. It exists in the design only so that a provider that matters enough to need compile-time types has a path that is still not hand-authored.

**Tier 2 — hand-written capability ports. Schemas we author: single digits, permanently.**
`CodeHostActions` and `DocsActions` live here, and the shape of them is narrower than the [new contract](#the-new-contract) sketch suggests. A capability port is **a product concept that needs one shape across providers** — not a mirror of any provider's API. `listRepositories` is the archetype: it paginates ten pages of a hundred, normalizes the response into `CodeHostRepository`, and exists because the onboarding repo picker needs one shape regardless of which code host is connected.

A method is admitted to Tier 2 only if all three hold:
- a shipped product feature depends on it, not "an agent might want it";
- more than one provider must satisfy it identically; and
- the normalized shape differs from every provider's raw response.

`listRepositories` passes all three. `createIssue`, `sendMessage` and `searchDocuments` pass none today and are brokered. If a fourth method is ever proposed for Tier 2, the admission test is the review, and failing it means the action belongs to an MCP server.

| | Tier 0 (brokered) | Tier 2 (typed port) |
|---|---|---|
| coverage | every provider with an MCP server | the five registered integrations |
| who owns the schema | the server author | us |
| compile-time types | none; validated at runtime | full |
| destructiveness source | the tool's MCP annotations | our manifest |
| token custody | gateway-bound; never in the agent transcript | never leaves the process |
| cost of a new provider | zero files | one port implementation |

The two tiers meet at `getToken`. A brokered call and a typed port call both pass the same capability guard, the same refresh path, and the same errored-credential classification. The difference is only who wrote the schema.

### Invoking an action

One generic path replaces the bespoke `listRepositories` method on the service:

```
service.invokeAction(connectionId, capability, actionName, args)
  → connections.getById(connectionId)
  → getToken(connectionId, capability)          ← guard + refresh, unchanged
  → manifest[capability][actionName].destructive ? requireApproval(...) : proceed
  → ports[capability][actionName]({ token, tokenType, fields, fetch }, ...args)
```

Everything left of the action call is existing, tested machinery. The change is that a new action reuses it instead of adding a method.

### Resolution with multiple accounts

`resolveForCapability(capability, options)` returns one handle per **connection**, not per integration. Ordering is defined: personal before team, then most recently used, then `createdAt`. `options.integration` narrows; `options.accountKey` selects exactly one. The `const [connection] =` destructure at the three hosted call sites becomes an explicit selection, because with two GitHub accounts "the first one" is no longer an answer.

### Agent-initiated connect

```
agent → service.proposeConnection({ integrationId, capability, reason })
      → requires impl.auth.device, else { ok: false, code: "device_grant_unavailable" }
      → returns { attemptId, userCode, verificationUri, intervalMs }    ← no authorization URL
human → enters the code at the provider
poll  → completes; owner is bound to the subject of the turn credential that polls to completion
agent → invokeAction(...) against the new connection
```

The device grant already exists in the kit because desktop and NAT self-hosters needed it. This is its second use, and the better one: an eight-character code typed by a person is a stronger consent record than a redirect click, and it yields exactly the human-verified subject that `resolveForCapability` requires.

## Implementation Units

All units are unstarted. Paths are repository-relative. Files marked new are proposed. Because there is no backward compatibility requirement, each unit **removes** the path it replaces in the same slice; no unit may leave two implementations of one responsibility behind.

- [ ] **Unit 0: Characterize the contract boundary**
  - Requirements: complete cutover, one current contract, no dangling consumers. Dependencies: none.
  - Owners: read-only across `packages/claxedo-connections/src/**`, `packages/claxedo-server/src/connections/**`, `packages/claxedo-server/src/agent-plugins/**`, `packages/claxedo-app/src/features/onboarding/**`.
  - Tests: none new; produces the ownership map that Units 1-9 partition against.
  - Record every consumer of `IntegrationCapability`, `IntegrationImpl`, `resolveForCapability`, `listRepositories`, `getToken`, `connect`, `connectOAuth`, and every exported symbol in `src/index.ts`, with its destination owner under the new contract. Record every route in `routes.ts` and whether it survives, changes shape, or is deleted.
  - Done when every current consumer has a named destination unit, the file ownership map has no overlap between units that may run in parallel, and the list of deleted exports is explicit.

- [x] **Unit 1: One credential adapter; `readSecret` stops writing**
  - Requirements: one implementation per responsibility; I-3 (a non-available credential never serves a token). Dependencies: none — this unit is independent of the contract rewrite and should land first.
  - Owners: `packages/claxedo-server/src/connections/store-adapter.ts`, `packages/claxedo-server/src/connections/hosted-d1/setup.ts` (its local `credentialStore()`), new `packages/claxedo-server/src/connections/credential-store-adapter.ts`.
  - Tests: existing `packages/claxedo-connections/src/conformance/credential-store.ts` run against both hosts; new case `read_secret_status_side_effects` promoted from `remaining` into a pinned case asserting that `readSecret` on an errored credential returns the secret **and leaves status errored**.
  - Delete both hand-written adapters. Build one factory over `ControlPlaneCredentials` and use it from the SQLite host and the hosted Worker. The hosted semantics are correct and become the shared semantics.
  - Done when one adapter file exists, the promoted conformance case passes on both hosts, and a failing re-verify provably leaves the token path refusing.

- [x] **Unit 2: Pin upsert semantics and give the conformance suites teeth**
  - Requirements: a port that promises one row per key must say which write wins. Dependencies: Unit 1's shared adapter for the credential half.
  - Owners: `packages/claxedo-connections/src/stores/memory.ts`, `packages/claxedo-server/src/connections/store-adapter.ts`, `packages/claxedo-connections/src/conformance/connection-store.ts`, `packages/claxedo-connections/src/types.ts` (port doc comments).
  - Tests: `upsert_rekeying` promoted from `remaining` into a pinned case; new `packages/claxedo-connections/src/conformance/conformance-teeth.test.ts`.
  - Pin the D1 behavior as the contract and correct SQLite and memory to match. Split the connection suite into a partition-agnostic group and a partition group so the D1 adapter — which serves one `(org, user)` pair per instance — can run the first group; register it. Add a test that feeds each suite a deliberately broken adapter and asserts the matching case throws, so the suites are proven to have teeth rather than assumed to.
  - Done when all three adapters agree on the pinned semantics, D1 runs the partition-agnostic group in CI, `upsert_rekeying` is no longer in `remaining`, and the teeth test fails when a suite assertion is weakened.

- [x] **Unit 3: Delete the webhook surface**
  - Requirements: nothing stores a secret that nothing reads. Dependencies: Unit 0's consumer map confirming zero non-test consumers.
  - Owners: delete `packages/claxedo-connections/src/webhooks.ts` and `webhooks.test.ts`; remove the webhook exports from `src/index.ts`; delete the `PUT` and `DELETE /connections/:id/webhook-secret` routes at `routes.ts:241` and `:262`; remove `connectionWebhookSigningProviderId` from `types.ts`.
  - Tests: existing `routes.test.ts` updated to assert both routes are absent; a store-level assertion that no `:webhook-signing` provider id is written by any surviving path.
  - Any signing material already written by the deleted routes is orphaned by design and is removed by a one-shot cleanup in the same slice, not left behind.
  - Done when the package exports no webhook symbol, both routes 404, and no code path writes a signing credential.

- [x] **Unit 4: Capability ports replace capability tags**
  - Requirements: a capability name resolves to methods; a declaration cannot claim what it cannot serve. Dependencies: Unit 0.
  - Owners: `packages/claxedo-connections/src/types.ts`, `src/registry.ts`, new `src/ports/{code-host,docs,work-source,channel,mcp}.ts`; every file under `src/impls/`.
  - Tests: rewritten `registry.test.ts` asserting derived capabilities; new `src/ports/ports.test.ts` asserting an impl declaring a port must satisfy it; type-level assertions that a partial port fails to compile.
  - Introduce `CapabilityPorts`, derive `IntegrationCapability` from it, and split `IntegrationImpl` into `auth` and `actions`. Delete the authored `capabilities` array from every declaration; the registry computes it. Every impl moves its auth methods under `auth`.
  - **Brokered capabilities derive too.** `mcp` declares `BrokeredPort`, not an action map, so the synthesized integrations from [`mcpOAuthDeclaration`](../../packages/claxedo-server-core/src/agent-plugins/mcp/integration.ts#L46) — which today author `capabilities: ["mcp"]` by hand — derive `["mcp"]` and not `[]`. Naive `Object.keys(impl.actions)` derivation breaks the entire MCP rail; the registry must treat a brokered declaration as satisfying its capability.
  - Done when `decl.capabilities` is unwritable by an integration author, every impl compiles under the split shape, a declaration cannot name a capability whose port it does not implement, and a synthesized MCP integration still resolves for `capability: "mcp"` through the unchanged gateway path.

- [ ] **Unit 5: The action layer and the generic invoker**
  - Requirements: adding an action widens no universal interface; no action receives a stored secret; destructive actions are gated structurally. Dependencies: Unit 4.
  - Owners: `packages/claxedo-connections/src/service.ts` (add `invokeAction`, delete `listRepositories`), `src/types.ts` (`ActionContext`, `ActionManifest`), `src/routes.ts` (replace `GET /connections/:id/repositories`), and the three consumers at `packages/claxedo-server/src/connections/index.ts:140`, `hosted-d1/setup.ts:264`, `deployments/self-hosted-node/app.ts:1101`.
  - Tests: rewritten `src/impls/github-repositories.test.ts` against the port; new `src/actions.test.ts` covering capability refusal, destructive refusal without approval, token-not-secret, abort propagation, and a provider 401 marking the credential errored.
  - `listRepositories` already sits on `CodeHostPort` — Unit 4 had to move it, because "a declaration cannot name a capability whose port it does not implement" is unsatisfiable while `code-host` is an empty marker. What remains here is the invoker, the manifest, and the deletion of the direct `(fields, secret: string)` call path.
  - `invokeAction` routes through the existing `getToken` path unchanged, so the guard, refresh buffer, single-flight and definitive-versus-transient classification are inherited rather than reimplemented. The `(fields, secret: string)` signature is deleted outright.
  - **This unit ships exactly one action.** `listRepositories` is the whole Tier 2 corpus at the end of this unit, and the manifest exists to make the *next* action cheap, not to be filled. The three-part admission test in [Where action schemas come from](#where-action-schemas-come-from) is recorded in the port file's header so a future author is refused by the doc rather than by review. Any provider action not passing it is served brokered, through the MCP rail, whose schemas we do not own.
  - Done when `IntegrationImpl` has no provider-specific method, `listRepositories` is reachable only through `invokeAction`, a destructive action cannot execute without an approval decision, no action signature can receive a stored secret, and the hand-authored action count is exactly one.

- [ ] **Unit 6: Multiple accounts per provider**
  - Requirements: a person may hold several connections to one provider; resolution returns all of them. Dependencies: Units 2 and 4.
  - Owners: `packages/claxedo-connections/src/types.ts` (`ConnectionRow.accountKey`), `src/service.ts` (`connect`, `connectOAuth`, `resolveForCapability`, delete `connection_exists`/`confirmReplace`), `src/stores/memory.ts`, `packages/claxedo-server/src/connections/store-adapter.ts`, `hosted-d1/connection-store.ts` (index becomes `(org, owner, integration, account_key)`), `hosted-d1/setup.ts` (`existingFor` at line ~453), and the onboarding consumer in `packages/claxedo-app/src/features/onboarding/code-host-api.ts`.
  - Tests: promoted conformance cases for multi-account storage and listing; `service.test.ts` cases for two accounts on one provider, defined resolution ordering, and `accountKey` selection; a route test proving the list surface distinguishes two GitHub accounts.
  - `accountKey` is a stable provider-side identity returned by `verify` and by `callback`, distinct from the display-only `accountLabel`. Resolution ordering is defined — personal before team, then most recently used, then `createdAt` — replacing the current `Map`-insertion-order tiebreak. `options.integration` becomes optional narrowing rather than a required pin.
  - Done when two connections to one provider coexist for one owner, `resolveForCapability` returns both in the defined order, no caller relies on a first-element destructure, and `confirmReplace` no longer exists.

- [ ] **Unit 7: Grants become an explicit consent record**
  - Requirements: the granted set is chosen at connect and may be narrower than the provider offers. Dependencies: Units 4 and 6.
  - Owners: `packages/claxedo-connections/src/service.ts` (`storeConnection` at line ~154), `src/types.ts` (`ConnectionRow.grant`), `src/routes.ts` (`POST /:id/connect` accepts a grant), and the connect surfaces in `packages/claxedo-app/src/features/onboarding/**`.
  - Tests: `service.test.ts` cases for a narrowed grant refusing an ungranted capability, a grant naming a capability the provider lacks being rejected at connect, and the frozen grant surviving a later declaration change.
  - Replace `grantedCapabilities: [...decl.capabilities]` with an explicit `grant` supplied at connect, validated as a subset of the derived capabilities, and recorded with a timestamp and the capturing surface. Freezing at connect is preserved; what changes is that the value is now a decision rather than a copy.
  - Done when a connection can be created that serves `docs` but refuses `work-source` from the same provider, and the stored grant carries when and where consent was captured.

- [ ] **Unit 8: Agent-initiated connect via device grant**
  - Requirements: an agent proposes, a human completes, the completing human is the owner. Dependencies: Units 6 and 7.
  - Owners: `packages/claxedo-connections/src/service.ts` (new `proposeConnection`), `src/attempts.ts` (attempt carries proposal provenance), `src/routes.ts` (propose and poll surfaces), `packages/claxedo-server/src/connections/hosted-d1/setup.ts` (owner binding at completion).
  - Tests: new `src/propose-connect.test.ts` covering a provider without `device` refusing with `device_grant_unavailable`, the response never containing an authorization URL, owner binding to the polling subject rather than to the proposing turn, an expired grant, a denied grant, and a proposal completed by a different subject than the one that proposed.
  - `proposeConnection` returns `{ attemptId, userCode, verificationUri, intervalMs }` and never a redirect URL — a redirect URL in an agent-visible transcript is a phishing vector. Owner is bound at poll completion from the polling turn's credential, so an agent-proposed connection can never land owner-absent in the team partition.
  - Done when an agent can propose a connection it cannot complete, the resulting row's owner is the human who entered the code, and no proposal path can produce a team-partition row.

- [ ] **Unit 9: Lifecycle hardening**
  - Requirements: removal revokes; refresh is safe across isolates; the desktop key leaves the filesystem. Dependencies: Unit 1.
  - Owners: `packages/claxedo-connections/src/service.ts` (`remove`), `src/types.ts` (`AuthImpl.revoke`), `src/vendor/arctic/google.ts` (`revokeToken` already present), `src/tokens.ts` (single-flight), `packages/claxedo-server-core/src/credentials/backends/local.ts`, and the desktop `SecretBackend` registration.
  - Tests: `service.test.ts` case asserting `remove` attempts revocation and still succeeds when the provider rejects; `tokens.test.ts` case for two concurrent refreshes across simulated isolates producing one provider call and one stored result; a desktop backend test asserting the key is not derivable from files beside the ciphertext.
  - Add best-effort provider-side revocation on remove — failure must not block local deletion. Replace the per-process single-flight `Map` with a compare-and-set on the hosted credential record or a D1 lease keyed by provider id, so hosted isolates cannot race a rotating provider. Move the desktop key to the OS keychain via Electron `safeStorage`.
  - Done when removal revokes where the provider supports it, two isolates refreshing concurrently produce one provider call, and the desktop key is not recoverable from the filesystem alone.

- [ ] **Unit 10: Documentation and export surface**
  - Requirements: the docs describe live code. Dependencies: Units 1-9.
  - Owners: `packages/claxedo-connections/README.md` (the single authoritative package doc), `src/index.ts`.
  - Tests: a public-API test pinning the exported surface so an accidental export is a failing test rather than a review catch.
  - Update the README's security invariant list with the new enforcement points from Units 5, 7 and 8, and its constraints section with what Units 6-9 changed.
  - Done when no document describes a deleted symbol, the export surface is pinned by a test, and §10 contains only rows that remain open.

## System-Wide Impact

**Consumers that change shape.** The three hosted capability resolvers in `hosted-d1/setup.ts` lose their first-element destructure and select explicitly. `connections/index.ts:140` and `deployments/self-hosted-node/app.ts:1101` move from `service.listRepositories(id)` to `invokeAction`. The onboarding repo picker gains an account dimension. `agent-plugins/mcp/runtime-preparation.ts` is affected only through `resolveConnection`'s return shape, which now carries `accountKey`.

**Stored data.** The connection row gains `accountKey` and `grant` and its uniqueness index changes. Per the owner's clean-break direction there is no migration: rows written under the old contract are not required to load, and the deleted webhook signing credentials are removed rather than orphaned.

**Designed for, not built here.** Two future workstreams consume this seam and are the reason the interface is shaped this way rather than minimally:
- A **corpus search/describe** surface over the agent-plugins catalog would read the action manifests introduced in Unit 5.
- **Code-mode sandbox execution** would call `invokeAction` with tokens bound outbound per host exactly as `mintMcpGatewayToken` does, inheriting the egress allowlist. Every new provider host becomes an explicit `extraHosts` decision, which is an operational cost this plan does not pay down.

Neither is in scope. Unit 5's manifest and Unit 8's consent boundary exist so that when they arrive they extend the contract instead of reopening it.

## Alternative Approaches Considered

**Delete the capability concept and pass `integrationId` everywhere.** Production already behaves this way, so this is the smallest change. Rejected: it discards the `403 capability_not_granted` guard, which is a real containment boundary — a connection made for `code-host` genuinely cannot have its token pulled by the MCP path today.

**Keep tags and add actions as more optional methods on `IntegrationImpl`.** Cheapest per action. Rejected: it is the current shape, and its cost is superlinear — the eighth action leaves an interface where nearly every field is optional and nothing type-checks the pairing between a tag and the methods it implies.

**Adopt an external integration platform for the action layer.** Nango, Composio and Executor all ship far more provider coverage than this kit will. Rejected on two constraints this plan cannot relax: custody of the refresh token must stay inside the customer's trust boundary, and the local Electron/SQLite deployment must work with no account and no internet-facing callback. Executor's destructiveness taxonomy is worth taking, and Unit 5 takes it.

**Let the agent complete connections.** Rejected on the owner argument in [Open Questions](#resolved-during-planning), not on effort.

## Success Metrics

- Adding a new action to an existing provider touches one port file and one manifest entry, and no shared interface.
- Adding a new provider that serves an existing capability requires implementing that capability's port in full, enforced by the compiler.
- **The hand-authored action count stays in single digits as provider coverage grows.** A new provider is normally added by activating an MCP server, which adds no file to this package.
- A consumer can hold two accounts on one provider and choose between them.
- Both conformance suites run against all three adapters, and the teeth test proves they fail a broken one.

## Dependencies / Prerequisites

- The working tree must be committed before parallel execution begins. The branch carries substantial uncommitted work, and review or mutation-testing subagents have historically reverted uncommitted edits.
- No new external dependency. The vendored arctic client already provides `revokeToken` for Unit 9.
- `bun run test:architecture-ratchets` must pass after Units 4, 5 and 6, each of which redirects production imports.

## Risk Analysis & Mitigation

| Risk | Mitigation |
|---|---|
| Unit 6 changes the store's uniqueness index; a half-applied change silently allows duplicate rows or refuses valid ones. | Land the index change and the pinned conformance case in one slice; the promoted `upsert_rekeying` case from Unit 2 must already be green before Unit 6 begins. |
| The `[first]` destructure pattern is safe today only because `integration` is always passed; Unit 6 makes it genuinely unsafe. | Unit 0's consumer map enumerates every destructure site, and Unit 6 is not done until each one selects explicitly. |
| Deleting the webhook surface removes a capability someone intended to use. | Unit 3 depends on Unit 0's confirmation of zero non-test consumers. Restoring it later is a mounted route plus an end-to-end test, not a rewrite. |
| Units 4-7 touch overlapping files and cannot be parallelized naively. | The dependency chain 4 → 5 → 6 → 7 is sequential by design; parallelism comes from running 1, 2, 3 and 9 alongside it. |
| Unit 9's distributed refresh lease is the only unit whose correctness cannot be proven by a single-process test. | Its acceptance requires a simulated two-isolate test asserting exactly one provider call, not a passing unit test. |

## Phased Delivery

### Phase 1 — Correctness, independent of the contract rewrite
Units 1, 2, 3. Closes the diverged adapters, the unpinned upsert semantics, the untested conformance suites, and the unreachable webhook surface. Shippable on its own and valuable even if Phase 2 is deferred.

### Phase 2 — The contract rewrite
Units 4, 5, 6, 7, strictly in order. This is the clean break. At its end a capability implies methods, actions live in ports behind one invoker, several accounts per provider are supported, and the grant is a consent record.

### Phase 3 — Lifecycle and surface
Units 9 and 10. Revocation, distributed refresh, the desktop keychain, and bringing every document onto the live code.

## Definition of Done

- [ ] `IntegrationCapability` is `keyof CapabilityPorts`, and `decl.capabilities` is derived at registration rather than authored. Progress:
- [ ] `IntegrationImpl` contains no provider-specific method; `listRepositories` is reachable only through `invokeAction`. Progress:
- [ ] No action signature can receive a stored secret; every action receives an `ActionContext` carrying a live, capability-checked token. Progress:
- [ ] A destructive action cannot execute without an explicit approval decision, enforced in the invoker rather than at call sites. Progress:
- [ ] One owner holds two connections to one provider; `resolveForCapability` returns both in the defined order and no consumer uses a first-element destructure. Progress:
- [ ] A connection can be granted a strict subset of what its provider offers, and the grant records when and where consent was captured. Progress:
- [ ] An agent can propose a connection and cannot complete one; the resulting owner is the human who entered the device code; no proposal path yields a team-partition row. Progress:
- [ ] One `CredentialStorePort` implementation serves both hosts, and `readSecret` provably never writes status. Progress:
- [ ] Both conformance suites run against memory, SQLite and D1, and a deliberately broken adapter fails them. Progress:
- [ ] `remove` attempts provider-side revocation and still succeeds when the provider rejects. Progress:
- [ ] Two concurrent refreshes across simulated isolates produce exactly one provider call and one stored result. Progress:
- [ ] The desktop secret key is held by the OS keychain and is not recoverable from the filesystem alone. Progress:
- [ ] The package exports no webhook symbol and no route writes a signing credential. Progress:
- [ ] The export surface is pinned by a test, and the README describes no deleted symbol and no closed gap. Progress:
- [ ] `bun run typecheck`, `bun test` in the package, the full host suites, and `bun run test:architecture-ratchets` are green, with the exact commands and outcomes recorded. Progress:

## Execution: parallelize with agents and workflows

**Commit the working tree first.** This branch carries substantial uncommitted work. Review and mutation-testing subagents have previously reverted uncommitted edits, and stashing on a shared worktree has caused silent work loss. Neither is acceptable here.

**Disjoint file ownership is mandatory.** Unit 0 produces the ownership map before any implementation agent starts, and no two concurrently running units may name the same file as an owner.

Recommended parallel shape:

- **Wave A, four agents concurrently.** Unit 1 (`store-adapter.ts`, hosted `setup.ts` credential block), Unit 3 (`webhooks.*`, two routes), Unit 9's desktop keychain half (`credentials/backends/local.ts`), and Unit 0's consumer map. These four share no files.
- **Wave B, sequential single agent.** Units 4 → 5 → 6 → 7. This chain rewrites `types.ts`, `service.ts` and every impl; splitting it across agents would produce the absorb-versus-rewrite conflict this repo has hit before. One agent, four commits.
- **Wave C, two agents concurrently.** Unit 2's conformance work and Unit 9's refresh-lease half, both against the contract Wave B settled.
- **Wave D, single agent.** Unit 10, after everything else is green.

Run verification in parallel with implementation where it does not contend: package tests, host suites, typecheck, and the architecture ratchets are four independent commands. Research questions deferred above — `accountKey` derivation per provider, the approval-token shape — should be answered by parallel research agents during Wave A rather than blocking Wave B.

## Sources & References

- [Package README](../../packages/claxedo-connections/README.md) — the single authoritative doc: capability-port model, connect/verify/attempt machine, the two-port storage seam, the token path, and the security invariants.
- [`service.ts:233-243`](../../packages/claxedo-connections/src/service.ts#L233-L243) — the owner/turn-credential invariant that rules out agent-completed connections.
- [`runtime-preparation.ts:271-305`](../../packages/claxedo-server/src/agent-plugins/mcp/runtime-preparation.ts#L271-L305) — the reference gateway token binding.
- [`hosted-network-policy.ts`](../../packages/sandbox-manager/src/hosted-network-policy.ts) — the egress allowlist any future code-mode work inherits.
- RFC 8628, OAuth 2.0 Device Authorization Grant — the consent mechanism behind Unit 8.
