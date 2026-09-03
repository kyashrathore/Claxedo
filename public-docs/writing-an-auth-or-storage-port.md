# Writing your own auth or storage port

Claxedo ships one certified stack: **Better Auth** for identity and
**Cloudflare D1** for the control-plane database, with SQLite for the
self-hosted single binary. This page is for the case where you want a
different one — Clerk, Convex, Auth0, Postgres, your own service — and want to
know exactly where your code plugs in and what it has to satisfy.

The short version: identity and persistence are **injected ports**, not
imports. The hosted composition graph contains no identity-provider or
database implementation. You write an adapter, hand it to the composition, and
nothing in the neutral graph changes.

## Read this first: what this is and is not

- **This is an in-repo port, not a plugin.** `@claxedo/server` is
  `private: true` and is not published to npm. You do this in a fork or a
  vendored copy of the repo, adding files beside the existing adapters.
- **There is no runtime adapter registry.** Adapter selection is a *static*
  decision made by a build/deploy entrypoint. That is deliberate: discovering a
  credential must never select a product or a backend. You add an entrypoint;
  you do not add a config flag that swaps implementations at request time.
- **The certified profile list is a real gate.** Adding an adapter is not the
  same as certifying it. `resolveDeploymentProfile` refuses any combination the
  deployment workflows do not prove. Widening it is your call and your
  responsibility.

## The five ports

| Port | Contract | Reference implementations |
|---|---|---|
| Identity (server) | `ControlPlaneAuthAdapter` in [`platform/auth/auth.ts`](../packages/claxedo-server-core/src/platform/auth/auth.ts) | Better Auth |
| Identity (browser) | `BrowserAuthAdapter` in [`platform/auth/browser-auth.ts`](../packages/claxedo-app/src/platform/auth/browser-auth.ts) | [`better-auth-browser-auth.ts`](../packages/claxedo-app/src/platform/auth/better-auth-browser-auth.ts) |
| Application authority (tenancy, workspaces, sessions, orgs) | `WorkspaceAuthority` in [`platform/auth/authority.ts`](../packages/claxedo-server-core/src/platform/auth/authority.ts) | [D1](../packages/claxedo-server/src/authority/adapters/d1/workspace-authority.ts), [SQLite](../packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts) |
| Sandbox leases | `SandboxLeaseStore` in [`sandbox-manager`](../packages/sandbox-manager/src/index.ts) | SQLite |
| Connections / credentials | conformance kit in [`@claxedo/connections`](../packages/claxedo-connections/src/conformance/index.ts) | memory, SQLite |

Two smaller ports exist for narrower work: `WakeStore` in
[`@claxedo/wakes`](../packages/wakes/src/store.ts), and
`WorkspaceRuntimeRouteContribution` in
[`@claxedo/workspace-runtime`](../packages/workspace-runtime/src/route-contribution.ts)
for adding route groups to a workspace runtime without the runtime importing
your feature.

## The one seam that matters

Everything hosted converges on this:

```ts
// packages/claxedo-server/src/authority/provider-neutral-hosted-services.ts
export type HostedControlPlaneAdapterBindings = {
  auth: ControlPlaneAuthAdapter
  authority: WorkspaceAuthority
  userHostedResolver: UserHostedTargetResolver
  cliSessionTokenRegistry?: CliSessionTokenRegistry
  sandbox?: { driver: SandboxDriver; leaseStore: SandboxLeaseStore }
  deviceAuthProvider?: HostedDeviceAuthProvider
  runtimeSessionAuthority?: RuntimeSessionAuthorityOptions["authority"]
  privateSessionAuthority?: PrivateSessionAuthority
  turnAuthority?: SessionTurnAuthority
}

export function composeProviderNeutralHostedControlPlane(
  env: HostedWorkerEnv,
  bindings: HostedControlPlaneAdapterBindings,
): HostedControlPlane
```

Produce that object and the whole hosted control plane composes on top of it.
Three fields are required; the rest are opt-in capabilities. Note
`privateSessionAuthority`, which is documented as *never synthesized from
`WorkspaceAuthority`* even when the shapes overlap — supply it explicitly or
your deployment does not admit private sessions.

The Better Auth + D1 adapter that fills this in is
[`better-auth-d1-compose.ts`](../packages/claxedo-server/src/authority/adapters/worker/better-auth-d1-compose.ts).
**Read it as your template.** Your port is a sibling of that file.

For the self-hosted Node binary the equivalent seam is
`ControlPlaneServicesOptions` in
[`authority/services.ts`](../packages/claxedo-server/src/authority/services.ts),
whose comment states the rule plainly: *the authority is always injected by the
composition site; the generic services never construct one.*

## A Clerk identity port, concretely

The server already has a slot for you. `AUTH_ADAPTERS` in
[`authentication.ts`](../packages/claxedo-server-core/src/platform/auth/authentication.ts)
is `["better-auth", "custom"]`, and the control-plane database's `adapter`
CHECK constraint matches it
([migration 0017](../packages/claxedo-server/migrations/control-plane/0017_adapter_custom.sql)).
**A third-party identity provider registers as `"custom"` and needs no schema
migration.**

1. Build the adapter with `customVerifierAuthAdapter({ issuer, audience, jwksUrl, verifier })`
   from [`auth.ts`](../packages/claxedo-server-core/src/platform/auth/auth.ts).
   Your `verifier` turns a bearer token into a `VerifiedControlPlaneAuth`.
   `betterAuthAdapter` is the same function with a session-shape decoder in
   front — copy its shape.
2. If your provider issues its own CLI/device token sets rather than OAuth,
   also implement `AdapterNativeSessionAuthPort` (`issue` / `refresh` /
   `authenticate` / `revoke` / `acceptsAccessToken` / `acceptsRefreshToken`) and
   pass it as `native`. Better Auth deliberately does not implement this port —
   its OAuth server owns device authorization and RFC 7009 revocation directly —
   so this branch exists precisely for providers like Clerk.
3. Browser side: add your id to `BROWSER_AUTH_ADAPTERS`, write a module
   implementing `BrowserAuthAdapter` (`initialize` / `useAuth` / `getToken`,
   plus a unique `implementationMarker`), and add a branch to
   `resolveBrowserAuthBuildSelection` in
   [`vite.browser-auth.ts`](../packages/claxedo-app/vite.browser-auth.ts) naming
   your module and its vendor chunk.

   Two rules the port enforces and you must respect: `initialize()` must
   **resolve in every case**, including when nobody can be signed in — a
   rejection has nowhere to go but a startup-failure panel that replaces the
   whole shell. And your vendor chunk name must be distinct, because the local
   (unsigned) build asserts your provider is absent from its artifact by both
   content and chunk name.

## A Convex storage port, concretely

`WorkspaceAuthority` is the honest cost here: **71 methods**, covering
identity, orgs, projects, workspaces, sessions, shares, channels, runtime
tokens, and audit. It is one interface rather than five
because it is one transaction domain. There is no partial-implementation path;
`requireAuthority()` fails closed.

What makes this tractable is that you do not have to guess whether you got it
right. Two runner-neutral conformance suites exist and **both the D1 and SQLite
adapters run the same ones**, which is what proves they are adapter-neutral
rather than written around one implementation:

- [`private-session-authority.conformance.ts`](../packages/claxedo-server-core/src/platform/auth/private-session-authority.conformance.ts)
- [`session-turn-authority.conformance.ts`](../packages/claxedo-server-core/src/platform/auth/session-turn-authority.conformance.ts)

Register them against your adapter with your own test runner, the way
`packages/claxedo-server/src/authority/adapters/d1/session-authority.test.ts`
does. `@claxedo/connections` ships the same pattern for connection and
credential stores.

Be aware of the gap: those suites cover private sessions and session turns, not
all 71 methods. The rest is on you, and the D1 and SQLite adapter test files are
the best available specification of the intended semantics.

## Declaring the profile

[`deployment-profile.ts`](../packages/claxedo-server/src/deployments/hosted-shared/deployment-profile.ts)
is where a deployment says what it is. The type already separates the two axes
you care about:

```ts
adapterProfile: "better-auth-d1"
authAdapter: "better-auth"
controlPlaneAdapter: "d1"
```

so `clerk-convex`, `clerk-d1`, and `better-auth-convex` are all expressible
without reshaping the type — add a member to `CERTIFIED_ADAPTER_PROFILES` and a
branch to the `CommonDeploymentProfile` union.

**One honest caveat.** `authAdapter` and `controlPlaneAdapter` are currently
*descriptive only* — nothing downstream dispatches on them. The real selection
happens statically in the worker entrypoint
([`better-auth-d1-candidate-worker.cf.ts`](../packages/claxedo-server/src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts)),
which imports one compose function by name. So your port needs **both**: a new
profile member *and* a new `.cf.ts` entrypoint that calls your compose
function. Do not expect setting the profile string alone to change which
adapter runs.

## Checklist

1. Implement `ControlPlaneAuthAdapter` (and `AdapterNativeSessionAuthPort` if
   your provider owns its own token sets).
2. Implement `WorkspaceAuthority`. Run both conformance suites against it.
3. Write `<your-profile>-compose.ts` beside `better-auth-d1-compose.ts`,
   returning `HostedControlPlaneAdapterBindings`.
4. Write a `.cf.ts` (or Node) entrypoint that calls it, and register the
   artifact in `certified-worker-artifacts.ts`.
5. Add the profile to `CERTIFIED_ADAPTER_PROFILES` and the profile union.
6. Browser: add the adapter id, the adapter module, and the build selector
   branch.
7. Run `bun run typecheck` and `bun run test:architecture-ratchets`. The
   ratchets pin each product's module and package closure with **no headroom**,
   so your adapter will move them — re-measure and re-pin with a comment naming
   the reviewed owner, per `CLAUDE.md`.

## What you inherit for free

Everything above the ports is provider-neutral and already written: the relay
and runtime-access-token machinery, sandbox lease management, the private
session and share model, channels, the workspace runtime and
its route-contribution seam, MCP tools, and the whole app shell. The ports are
the only place a backend is named.
