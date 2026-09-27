# Agent Guide

This is the first file a coding agent should read when using
`@claxedo/agent-sdk-runtime`.

## Package Job

Use this package for the shapes and helpers that every Claxedo runtime host and
client share: sessions, prompts, session config, harness identity, permission
ceilings, provider projections, the client-presentation event bridge, and the
durable store contract.

Do not use this package to start or prompt a harness: that is the runtime host
in `@claxedo/workspace-runtime` over the transports in `@claxedo/harness`. Do
not use it for product auth, database sync, workspace sharing, billing, HTTP
route policy, or gateway resolution. Hosts own those concerns.

## Decision Table

| Need | Read | Import from |
| --- | --- | --- |
| Mental model | [concepts.md](./concepts.md) | no import |
| Stable types and helpers | [api.md](./api.md) | `@claxedo/agent-sdk-runtime` |
| Host/runtime boundary | [boundaries.md](./boundaries.md) | no import |
| Client-presentation events | [api.md](./api.md) | `@claxedo/agent-sdk-runtime/compat-events` |
| Store contract and test stores | [recipes.md](./recipes.md) | `@claxedo/agent-sdk-runtime/adapters`, `./stores/*` |
| Copy-paste examples | [recipes.md](./recipes.md) | depends on recipe |

## Stability Labels

| Label | Meaning |
| --- | --- |
| Stable | Intended public API for external hosts. |
| Integration | Public contract surfaces imported from explicit subpaths. |
| Compatibility | Bridge for OpenCode or legacy Claxedo shapes. Do not build new systems around it. |
| Advanced | Lower-level surfaces (the store contract) for host integrations. |

## Default Import Rules

Use root imports for shared types and config helpers:

```ts
import { admitSessionInstructions, resolveSessionModel, type AgentSession, type SessionConfig } from "@claxedo/agent-sdk-runtime"
```

Use subpaths for the event bridge, provider projections, the store contract and stores:

```ts
import { toCompatEvent } from "@claxedo/agent-sdk-runtime/compat-events"
import { providerProjectionRecord } from "@claxedo/agent-sdk-runtime/provider-projection"
import type { AgentRuntimeStoreWithRecovery } from "@claxedo/agent-sdk-runtime/adapters"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
```
