# `claxedo-server/src/control-plane`

The Control Plane is `claxedo-server`'s authority layer. It owns:

- `auth.ts` — Clerk JWT verification through
  `@claxedo/workspace-relay-protocol/createClerkTokenVerifier`,
  `controlPlaneAuthContext()`, `tokenVerifierAsClerk()` adapter (P-shared.2)
- `authority.ts` — the neutral `WorkspaceAuthority` port (typed capability for
  workspace, project, session, and org operations) plus `requireAuthority()`
- `adapters/convex/*` — Claxedo's Convex-backed implementation of the authority
  port; the only control-plane files permitted to name the storage backend
- `adapters/worker/hosted-compose.ts` — Worker-side authority/lease composition
  adapter (the single hosted composition module allowed to reach Convex)
- `runtime-access-token.ts` — RAT minting / verification
- `services.ts` — DI bag (`{ authority, tokenVerifier? }`)
- `projection-store.ts` — read model the UI consumes
- `durable-session-log.ts` — append-only session events

## Plugging in a custom token verifier (P-shared.2)

The Clerk-backed default works for hosted Claxedo deployments. Self-
hosted setups can swap it out via the unified
[`TokenVerifier`](../../../workspace-relay-protocol/src/token-verifier.ts)
interface and the `tokenVerifierAsClerk()` adapter:

```ts
import { createStaticTokenVerifier } from "@claxedo/workspace-relay-protocol"
import {
  controlPlaneAuthContext,
  tokenVerifierAsClerk,
} from "./auth"

const myVerifier = createStaticTokenVerifier({
  tokens: {
    "tok-tenant-1": {
      subject: "user_1",
      scopes: ["workspace:read", "workspace:write"],
      claims: {
        iss: "my-idp.example",
        aud: "claxedo",
        sub: "user_1",
        workspace_id: "ws_1",
        host_id: "host_1",
        exp: Math.floor(Date.now() / 1000) + 300,
        iat: Math.floor(Date.now() / 1000),
        jti: "tok-tenant-1",
      },
    },
  },
})

const ctx = await controlPlaneAuthContext(req, {
  verifier: tokenVerifierAsClerk(myVerifier),
})
```

The adapter trusts your verifier to enforce issuer / audience / expiry
itself; it carries through `sub`, `iss`, `aud`, `azp`, and `org_id`
onto the existing `VerifiedClerkAuth` shape so downstream
`projection-store` / authority readers are unchanged.

## Seam vs `workspace-relay`

This module is the **control-plane auth** layer. The transport-level
auth (Relay Host Token verification, runtime-access tokens at the wire
boundary) lives in `@claxedo/workspace-relay`. See
`packages/workspace-relay/README.md` "Seam: internal-relay vs
workspace-relay" for the split.
