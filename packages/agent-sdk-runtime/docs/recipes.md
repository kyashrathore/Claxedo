# Recipes

Every recipe below uses only this package. Running a harness is
`@claxedo/workspace-runtime` (`createWorkspaceRuntimeApp`, `createWorkspaceHost`)
over `@claxedo/harness`; see that package's docs for a session end to end.

## 1. Resolve what one turn runs with

```ts
import { resolveSessionModel, resolveTurnSystem, type SessionConfig } from "@claxedo/agent-sdk-runtime"

const config: SessionConfig = { harness: { id: "claude", access: "native" }, agent: "build", variant: null, instructions: "Answer in haiku." }
const model = resolveSessionModel(config)
const system = resolveTurnSystem(config, "turn-system-prompt", undefined)
```

## 2. Admit a retained instruction block

```ts
import { admitSessionInstructions } from "@claxedo/agent-sdk-runtime"

const refusal = admitSessionInstructions({ harness: "pi", channel: "none", instructions: "Answer in haiku." })
if (refusal) throw new Error(refusal.message)
```

## 3. Narrow a child's permission mode under its parent's ceiling

```ts
import { permissionCeilingAdmits, permissionModeLevel, widestPermissionModeUnder } from "@claxedo/agent-sdk-runtime"

const ceiling = permissionModeLevel(parentMode)
const admitted = permissionCeilingAdmits(ceiling, permissionModeLevel(requestedMode))
const fallback = widestPermissionModeUnder(modes, ceiling)
```

## 4. Validate a pushed provider projection

```ts
import { providerProjectionRecord, projectionRenewalDue } from "@claxedo/agent-sdk-runtime/provider-projection"

const auth = providerProjectionRecord(pushed, process.env, { onInvalid: "unavailable" }) ?? {}
for (const [id, projection] of Object.entries(auth)) {
  if (projectionRenewalDue(projection, Date.now())) renew(id)
}
```

## 5. Project canonical events for a client

```ts
import { toCompatEvent, withDir } from "@claxedo/agent-sdk-runtime/compat-events"

for await (const event of transportEvents) {
  const compat = toCompatEvent(event)
  if (compat) publish(withDir({ directory, sessionID }, compat))
}
```

## 6. Use a test store

```ts
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { AgentRuntimeStaleTurnError } from "@claxedo/agent-sdk-runtime/adapters"

const store = createMemoryRuntimeStore()
store.bindSession({ sessionId: "s1", directory: "/repo", agentSessionId: "up1" })
const leaseId = store.acquireTurnLease("s1")!
store.startTurn({ sessionId: "s1", assistantMessageId: "a1", agent: "build", parts: [] })
store.finishTurn({ sessionId: "s1", assistantMessageId: "a1", outcome: { state: "completed" }, leaseId })
```

A `finishTurn` with a lease the session no longer holds throws `AgentRuntimeStaleTurnError`; that is the store fencing a delayed writer, not a bug to work around.
