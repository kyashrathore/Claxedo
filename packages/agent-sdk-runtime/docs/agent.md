# Agent Guide

This is the first file a coding agent should read when using
`@claxedo/agent-sdk-runtime`.

## Package Job

Use this package to talk to agent harnesses through one host-facing
`AgentRuntime` facade.

It normalizes sessions, messages, prompts, harness config, capabilities,
permissions, questions, todos, and runtime event streams across supported
transports.

Do not use this package for product auth, database sync, workspace sharing,
channel idempotency, billing, HTTP route policy, or gateway resolution. Hosts
own those concerns.

## Decision Table

| Need | Read | Import from |
| --- | --- | --- |
| Mental model | [concepts.md](./concepts.md) | no import |
| Stable runtime facade | [api.md](./api.md) | `@claxedo/agent-sdk-runtime` |
| Host/runtime boundary | [boundaries.md](./boundaries.md) | no import |
| Harness adapters | [recipes.md](./recipes.md) | `@claxedo/agent-sdk-runtime/adapters` |
| In-memory or virtual session environment | [recipes.md](./recipes.md) | `@claxedo/agent-sdk-runtime/virtual-session-env` |
| Claxedo client-presentation events | [api.md](./api.md) | `@claxedo/agent-sdk-runtime/compat-events` |
| Copy-paste examples | [recipes.md](./recipes.md) | depends on recipe |

## Stability Labels

| Label | Meaning |
| --- | --- |
| Stable | Intended public API for external hosts. |
| Integration | Public harness/transport adapter API. Import from explicit subpaths. |
| Compatibility | Bridge for OpenCode or legacy Claxedo shapes. Do not build new systems around it. |
| Experimental | Public but may change before 1.0. |
| Internal | Not a supported public import. |
| Deprecated | Kept temporarily to avoid abrupt ecosystem breaks. |

## Default Import Rules

Use root imports for the runtime facade and shared host-visible types:

```ts
import {
  createAgentRuntime,
  type AgentSession,
  type SessionConfig,
} from "@claxedo/agent-sdk-runtime"
```

Use subpaths for adapters and stores:

```ts
import { ClaudeHarnessAdapter, CodexHarnessAdapter, PiHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { createSqliteRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/sqlite"
```

Register concrete adapters through `AgentHarnessFactory` records so the runtime
provides their store, event hub, and failure sink.
