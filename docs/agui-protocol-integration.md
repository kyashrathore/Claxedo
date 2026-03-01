# AG-UI Protocol Integration

Integrate the AG-UI protocol into Claxedo so external agents (LangGraph, CrewAI, etc.) and terminal agents can control the UI and access backend services through a unified `POST /tool-call` endpoint. Two execution paths: backend tools proxy to OpenCode APIs server-side; frontend tools broadcast via SSE to the browser.

## Phase 1: Server Foundation

### Step 1: Install `@ag-ui/core`

```bash
cd claxedo && bun add @ag-ui/core
cd packages/claxedo-app && bun add @ag-ui/core
```

### Step 2: Create `claxedo/src/server/agui/sessions.ts`

Pending frontend tool call tracking + UI state cache.

Key exports:
- `waitForToolResult(callId, timeoutMs)` — returns a Promise that resolves when frontend POSTs result
- `resolveToolResult(callId, result)` — resolves the pending promise
- `setUIState(state)` / `getUIState()` — cache for UI snapshots pushed from frontend
- Uses a `Map<string, { resolve, timer }>` for pending calls

### Step 3: Create `claxedo/src/server/agui/tools.ts`

Tool catalog with `type: "backend" | "frontend"` metadata.

Each tool: `{ name, type, description, parameters: { name, type, required, description }[] }`

Full catalog of ~35 tools split into backend (process, file, git, session, system) and frontend (tabs, comments, layout, state).

### Step 4: Create `claxedo/src/server/agui/backend-tools.ts`

Backend tool executor. Resolves upstream URL for a directory, then proxies to OpenCode APIs.

Key function: `executeBackendTool(toolName, args, directory?)`

Upstream resolution pattern (from existing codebase):
- **Cloud mode** (`Config.SANDBOX_ENABLED`): `resolveDirectoryUpstream(directory)` from `claxedo/src/services/sandbox-resolver.ts` → returns `{ sandboxUrl }`
- **Local mode**: `Config.OPENCODE_URL` from `claxedo/src/config/index.ts`

Helper functions:
- `resolveUpstream(directory?)` — returns base URL string
- `proxyGet(upstream, path)` — `fetch(upstream + path)` and return JSON
- `proxyPost(upstream, path, body)` — POST to upstream
- `proxyDelete(upstream, path)` — DELETE to upstream
- `getPtyLogs(upstream, ptyId, cursor?)` — WebSocket connection to `/pty/:ptyID/connect`, collect output for up to 2s

Switch statement mapping all backend tool names to OpenCode API calls:

| Tool Name | Method | API Path |
|-----------|--------|----------|
| `listProcesses` | GET | `/pty` |
| `getProcess` | GET | `/pty/:ptyId` |
| `createProcess` | POST | `/pty` |
| `killProcess` | DELETE | `/pty/:ptyId` |
| `getProcessLogs` | WS | `/pty/:ptyId/connect` |
| `resizeProcess` | PUT | `/pty/:ptyId` |
| `readFile` | GET | `/file/content?path=` |
| `listFiles` | GET | `/file?path=` |
| `searchCode` | GET | `/find?pattern=` |
| `findFiles` | GET | `/find/file?query=` |
| `getFileStatus` | GET | `/file/status` |
| `getDiff` | GET | `/session/:sessionId/diff` (or `/session/diff?mode=` for uncommitted) |
| `getDiffTargets` | GET | `/session/diff-targets` |
| `listSessions` | GET | `/session` |
| `getSession` | GET | `/session/:sessionId` |
| `getSessionMessages` | GET | `/session/:sessionId/message` |
| `createSession` | POST | `/session` |
| `sendPrompt` | POST | `/session/:sessionId/message` |
| `abortSession` | POST | `/session/:sessionId/abort` |
| `getConfig` | GET | `/config` |
| `healthCheck` | GET | `/global/health` |

### Step 5: Create `claxedo/src/server/routes/agui.ts`

Follows `agent-hook.ts` pattern — lazy-loaded Hono instance.

Routes:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/tool-call` | Main entry. Looks up tool in catalog, dispatches to backend executor or broadcasts to frontend via `broadcastGlobal()` + `waitForToolResult()` |
| POST | `/tool-result` | Frontend posts execution results, calls `resolveToolResult()` |
| GET | `/state` | Return cached UI state from `getUIState()` |
| POST | `/state` | Frontend pushes state, calls `setUIState()` |
| GET | `/tools` | Return full tool catalog |

Imports:
- `broadcastGlobal` from `../events/index.ts`
- `TOOL_CATALOG` from `../agui/tools.ts`
- `executeBackendTool` from `../agui/backend-tools.ts`
- `waitForToolResult, resolveToolResult, getUIState, setUIState` from `../agui/sessions.ts`
- `lazy` from `../lib/lazy.ts`

### Step 6: Mount routes in `claxedo/src/server/app.ts`

Changes:
1. Import `AguiRoutes` from `./routes/index.ts`
2. Mount authenticated route: `memberRoutes.route("/agui", AguiRoutes())`
3. Mount unauthenticated hook route:
   ```
   app.route("/hook/agui", AguiRoutes())
   app.route("/hook", AgentHookRoutes())
   ```
   Place these BEFORE the memberRoutes mount (after health check, before/after proxy middleware as needed). The `/hook` prefix should skip auth. Currently `AgentHookRoutes` is imported but never mounted — mount it at `/hook`.

Important: The `/hook/*` routes must be placed so they aren't intercepted by proxy middleware:
- `LocalProxyMiddleware` already skips `/hook` paths (`if (pathname.startsWith("/hook")) return next()`)
- `DirectoryProxyMiddleware` skips paths that don't match `shouldDirectoryProxy()` — `/hook` won't match
- Place hook routes after proxy middleware but before memberRoutes section

### Step 7: Export in `claxedo/src/server/routes/index.ts`

Add: `export { AguiRoutes } from "./agui.ts"`

---

## Phase 2: Frontend Listener

### Step 8: Create `packages/claxedo-app/src/agui/dispatcher.ts`

`executeToolCall(claxedo, comments, toolName, args)` — maps frontend tool names to claxedo layout / comments API calls.

Uses:
- `claxedo` from `useClaxedoLayout()` — has `topTabs`, `split`, `groupTabs()`, `groupLayout()`, `patchTab()`, `findTabGroup()`
- `comments` from `useComments()` — has `add()`, `remove()`, `clear()`, `setFocus()`
- Tab actions: `topTabs.addSession()`, `topTabs.addFile()`, `topTabs.addReview()`, `topTabs.addTerminal()`, `topTabs.close()`, `topTabs.patch()`
- Split actions: `split.toggle()`, `split.setFocus()`, `split.closeGroup()`, `split.moveTab()`
- Layout: `groupLayout(id).fileTree.setOpened()`

Tool → action mapping:

| Tool | Action |
|------|--------|
| `openSession` | `topTabs.addSession(dir, sessionId, title, badge)` |
| `openFile` | `topTabs.addFile(dir, filePath, title)` |
| `openReview` | `topTabs.addReview(dir, sessionId, title, badge, mode, fromRef, toRef)` |
| `openTerminal` | `topTabs.addTerminal(dir, terminalId, title)` |
| `closeTab` | `topTabs.close(tabId)` |
| `activateTab` | Find tab, set active |
| `patchTab` | `claxedo.patchTab(tabId, patch)` |
| `addComment` | `comments.add({ file, selection: { startLine, endLine }, comment })` |
| `removeComment` | `comments.remove(file, commentId)` |
| `clearComments` | `comments.clear()` |
| `focusComment` | `comments.setFocus({ file, id: commentId })` |
| `toggleSplit` | `split.toggle()` |
| `setFileTreeOpened` | `groupLayout(groupId).fileTree.setOpened(opened)` |
| `setFocusGroup` | `split.setFocus(groupId)` |
| `addGroup` | `split.toggle()` (creates group if only 1 exists) |
| `closeGroup` | `split.closeGroup(groupId)` |
| `moveTab` | `split.moveTab(tabId, fromGroupId, toGroupId)` |
| `getUIState` | Return snapshot (handled separately in state.ts) |
| `listTools` | Return catalog (handled on server) |

Returns `{ data, error? }`.

### Step 9: Create `packages/claxedo-app/src/agui/state.ts`

`buildStateSnapshot(claxedo, comments)` — serializes current UI state.

Returns:
```ts
{
  groups: claxedo.split.groups().map(g => ({
    id: g.id,
    tabs: { items: g.tabs.items, activeId: g.tabs.activeId }
  })),
  split: {
    focusedId: claxedo.split.focusedId(),
    direction: claxedo.split.direction(),
    sizes: claxedo.split.sizes(),
    hidden: claxedo.split.hidden(),
  },
  comments: comments.all(),
}
```

### Step 10: Create `packages/claxedo-app/src/agui/listener.ts`

`useAguiListener()` — SolidJS hook, same pattern as `useAgentHooks()` in `agent-hooks/listener.ts`.

Uses:
- `useGlobalSDK()` from `@/context/global-sdk` — for SSE event subscription
- `useClaxedoLayout()` — for dispatching UI actions
- `useComments()` from `@/context/comments` — for comment actions
- `useServer()` from `@/context/server` — for `server.url` to POST results back

Two effects:
1. **State push** — `setInterval` every 2s, POST state snapshot to `${server.url}/agui/state`
2. **Tool call listener** — `globalSDK.event.on("global", ...)`, filter for `agui.tool_call` events, dispatch via `executeToolCall()`, POST result to `${server.url}/agui/tool-result`

### Step 11: Wire into `ClaxedoLayout.tsx`

**File**: `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx`

At line 211 (inside `ClaxedoStateBridge`), add `useAguiListener()` after `useAgentHooks()`.

Add import: `import { useAguiListener } from "../agui/listener"`

---

## Phase 3: Terminal Integration

### Step 12: Create `packages/claxedo-app/src/agent-hooks/templates/agui-tool.ts`

`generateAguiToolScript(port)` — returns shell script string.

Follows pattern of `generateNotifyScript()` in `templates/notify.ts`.

```bash
#!/bin/bash
# Claxedo AG-UI tool helper
# Usage: claxedo-tool <toolName> [jsonArgs]
TOOL="$1"; ARGS="${2:-{}}"
curl -s -X POST "http://127.0.0.1:${CLAXEDO_PORT:-PORT}/hook/agui/tool-call" \
  -H "Content-Type: application/json" \
  -d "{\"toolName\":\"$TOOL\",\"args\":$ARGS}"
```

### Step 13: Update `packages/claxedo-app/src/agent-hooks/index.ts`

Changes:
1. Import `generateAguiToolScript` from `./templates/agui-tool`
2. In `setupAgentHooks()`: write `claxedo-tool` script to `BIN_DIR`
3. In `getTerminalEnvVars()`: add `CLAXEDO_AGUI_URL: \`http://127.0.0.1:${port}/hook/agui\``

---

## Files Summary

### New Files (8)

| File | Purpose |
|------|---------|
| `claxedo/src/server/agui/sessions.ts` | Pending call tracking + state cache |
| `claxedo/src/server/agui/tools.ts` | Tool catalog |
| `claxedo/src/server/agui/backend-tools.ts` | Backend tool executor |
| `claxedo/src/server/routes/agui.ts` | Hono routes |
| `packages/claxedo-app/src/agui/dispatcher.ts` | Frontend tool dispatcher |
| `packages/claxedo-app/src/agui/state.ts` | State snapshot builder |
| `packages/claxedo-app/src/agui/listener.ts` | SSE listener hook |
| `packages/claxedo-app/src/agent-hooks/templates/agui-tool.ts` | Shell script generator |

### Modified Files (5)

| File | Change |
|------|--------|
| `claxedo/package.json` | Add `@ag-ui/core` |
| `packages/claxedo-app/package.json` | Add `@ag-ui/core` |
| `claxedo/src/server/routes/index.ts` | Export `AguiRoutes` |
| `claxedo/src/server/app.ts` | Mount `/agui` + `/hook/agui` + `/hook` routes |
| `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx` | Add `useAguiListener()` |
| `packages/claxedo-app/src/agent-hooks/index.ts` | Generate `claxedo-tool` + add env var |

### Key Existing Code to Reuse

- `broadcastGlobal()` from `claxedo/src/server/events/bus.ts`
- `lazy()` from `claxedo/src/server/lib/lazy.ts`
- `resolveDirectoryUpstream()` from `claxedo/src/services/sandbox-resolver.ts`
- `Config` from `claxedo/src/config/index.ts` (for `OPENCODE_URL`, `SANDBOX_ENABLED`)
- `useGlobalSDK()` — SSE event subscription (`event.on("global", ...)`)
- `useClaxedoLayout()` — tab/split/group/layout actions
- `useComments()` from `@/context/comments` — add/remove/clear/setFocus
- `useServer()` from `@/context/server` — `server.url` for API calls
- Tab actions: `addSession`, `addFile`, `addReview`, `addTerminal`, `close`, `patch` from `tab-actions.ts`
- Split actions: `toggle`, `setFocus`, `closeGroup`, `moveTab` from `split.ts`

---

## Verification

```bash
# 1. TypeScript check
cd claxedo && npx tsc --noEmit
cd packages/claxedo-app && bun run typecheck

# 2. Backend tools (no browser needed):
curl -s -X POST http://localhost:3000/hook/agui/tool-call \
  -H "Content-Type: application/json" \
  -d '{"toolName":"healthCheck","args":{}}'

curl -s -X POST http://localhost:3000/hook/agui/tool-call \
  -H "Content-Type: application/json" \
  -d '{"toolName":"listTools","args":{}}'

curl -s http://localhost:3000/hook/agui/tools

# 3. Frontend tools (browser open):
curl -s -X POST http://localhost:3000/hook/agui/tool-call \
  -H "Content-Type: application/json" \
  -d '{"toolName":"getUIState","args":{}}'

# 4. Existing tests still pass:
cd packages/claxedo-app && bun run test
```
