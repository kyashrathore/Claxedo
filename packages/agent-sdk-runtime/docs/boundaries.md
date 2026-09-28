# Boundaries

`@claxedo/agent-sdk-runtime` owns the normalized host-facing shapes that every
Claxedo runtime host and client share.

## This Package Owns

- session, message, prompt and session config host-visible shapes
- harness identity tables and keys
- session config helpers (model, system block, instructions, titles)
- permission ceiling arithmetic
- provider credential projections and their record validator
- the client-presentation (compat) event bridge
- the durable store contract and the test stores that implement it

## Runtime Host Owns (`@claxedo/workspace-runtime`)

- starting, attaching to, prompting and cancelling harness sessions
- turn admission, leases and fencing
- recovery operations and their receipts
- child sessions and subagent admission
- runtime configuration and credential leases
- the HTTP routes that expose all of that

## Harness Transports Own (`@claxedo/harness`)

- translating one harness protocol to the canonical runtime events
- harness process or SDK integration
- harness-specific config probing, permission modes and todos
- the request broker that decides which request gets which answer

## Host Owns

- user authentication, authorization and role policy
- database persistence beyond the runtime store
- workspace and project visibility, sharing and channels
- HTTP/RPC route shape at the product edge
- billing, quotas and product UI state
