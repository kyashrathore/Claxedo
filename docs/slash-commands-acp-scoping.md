# Session Composer Slash Commands — ACP Scoping

Date: 2026-04-06

Status: planning

Related:

- [ACP → OpenCode Event Mapping](../packages/workspace-runtime/docs/acp-opencode-mapping.md)
- [ACP Tool Support Implementation](./acp-tool-support-implementation.md)
- [ACP Protocol: Slash Commands](https://agentclientprotocol.com/protocol/slash-commands)

## Purpose

This document defines how each session composer slash command behaves when the
active runner is an ACP-backed client (Claude, Codex, Cursor) versus the native
OpenCode runner. It is the implementation source of truth for filtering,
routing, and adapting slash commands per runner type.

## Non-goals

- Page editor slash commands (Tiptap block formatting in `claxedo-ui/components/slash-commands.tsx`) — those are unrelated to ACP.
- Introducing new slash commands — this doc scopes existing ones only.
- Changes to the upstream `packages/app` — all work is in the Claxedo override layer.

---

## Background

### Where slash commands come from

The session composer shows two kinds of slash commands in its popover:

1. **Server-side ("custom")** — fetched from `sync.data.command`, which comes from the `Command` service (`packages/opencode/src/command/index.ts`). Sources:
   - Built-in: `/init`, `/review`
   - User-defined: entries in `config.command`
   - MCP prompts: from `mcp.prompts()`
   - Skills: from `skill.all()`

2. **UI-side ("builtin")** — registered in `use-session-commands.tsx` with a `slash` property. These execute client-side actions (navigate, open dialog, call SDK method) and never round-trip as a "command" to the server.

### How they execute

- **Custom commands**: The submit handler (`prompt-input/submit.ts:453-484`) detects `/commandName` text, finds a match in `sync.data.command`, and calls `sdk.session.command()`. The server expands the command template and runs an LLM turn.

- **Builtin commands**: The slash popover handler (`prompt-input.tsx:640-657`) clears the editor and calls `command.trigger(cmd.id, "slash")`, which invokes the `onSelect` callback directly — no server involvement.

### How ACP handles commands today

The ACP agent (`packages/opencode/src/acp/agent.ts`) does two things:

1. **Advertises** commands via `available_commands_update` session notification (line 1252-1259) — all server-side commands from `sdk.command.list()` plus a hardcoded `/compact`.

2. **Executes** commands in the `prompt` handler (line 1396-1489) — parses `/name args` from prompt text, looks up in `sdk.command.list()`, calls `sdk.session.command()`. Falls back to a switch for `/compact` → `sdk.session.summarize()`.

---

## Runner types

From `acp-config.ts`:

```typescript
type RunnerType = "claude-acp" | "codex-acp" | "cursor-acp" | "opencode"
```

The `isAcpMode(scope)` helper returns `true` for all non-opencode runners.

---

## Command inventory

### Complete list of session composer slash commands (Claxedo override)

Source file: `packages/claxedo-app/src/overrides/pages/session/use-session-commands.tsx`

| # | Slash | Command ID | Category | What it does |
|---|-------|-----------|----------|--------------|
| 1 | `/new` | `session.new` | Session | Navigate to new session route |
| 2 | `/open` | `file.open` | File | Open file picker dialog |
| 3 | `/terminal` | `terminal.toggle` | View | Toggle terminal panel |
| 4 | `/steps` | `steps.toggle` | View | Toggle step expansion on active message |
| 5 | `/model` | `model.choose` | Model | Open model selection dialog |
| 6 | `/mcp` | `mcp.toggle` | MCP | Open MCP server selection dialog |
| 7 | `/agent` | `agent.cycle` | Agent | Cycle to next agent |
| 8 | `/undo` | `session.undo` | Session | Revert to before last user message |
| 9 | `/redo` | `session.redo` | Session | Re-apply a reverted message |
| 10 | `/compact` | `session.compact` | Session | Summarize session context |
| 11 | `/fork` | `session.fork` | Session | Open fork dialog |
| 12 | `/share` | `session.share` | Session | Create/copy share link |
| 13 | `/unshare` | `session.unshare` | Session | Remove share link |

Plus server-side custom commands (config, MCP prompts, skills) which appear
dynamically.

---

## Per-runner scoping decisions

### Decision table

| # | Slash | OpenCode runner | ACP runner | Rationale |
|---|-------|----------------|------------|-----------|
| 1 | `/new` | **Show** | **Show** | Works for both — creates a new session on whichever runner is active |
| 2 | `/open` | **Show** | **Show** | Client-side file picker, runner-independent |
| 3 | `/terminal` | **Show** | **Remove** | Terminal panel is a local concern; ACP clients have their own terminal. Not useful in cloud context. |
| 4 | `/steps` | **Show** | **Show** | UI-only step toggling, runner-independent |
| 5 | `/model` | **Show** (all OpenCode models) | **Show** (scoped to runner's `dynamicModels`) | ACP runners expose models via `availableModels` / config options. Dialog must show only those models, not the full OpenCode model list. Selection calls `acp.setModel()` which POSTs to `/api/claxedo/agent-config/runner/model`. |
| 6 | `/mcp` | **Show** (local MCP dialog) | **Hide** (deferred — requires centralized MCP subsystem) | For ACP runners, MCP servers are injected at session creation via `mcpServers` param in ACP `session/new`. A centralized MCP management UI is needed but is out of scope for this task. Hide `/mcp` for ACP runners until the subsystem exists (separate doc/task). |
| 7 | `/agent` | **Show** (cycle OpenCode agents) | **Show** (scoped to runner's `availableModes`) | ACP runners expose agents/modes via `availableModes`. Cycle should only iterate over modes from the active runner. Selection calls `acp.setAgent()`. **Prerequisite:** add `availableModes` to `ScopeState` in `acp-config.ts` (see Implementation section 3). |
| 8 | `/undo` | **Show** | **Hide** | Relies on `session.revert()` / `session.unrevert()` — OpenCode-specific server APIs with no ACP equivalent. |
| 9 | `/redo` | **Show** | **Hide** | Same as `/undo` — depends on OpenCode revert machinery. |
| 10 | `/compact` | **Show** (direct `session.summarize()`) | **Show** (pass as `/compact` text to ACP `session/prompt`) | ACP agent already handles `/compact` in its prompt handler switch statement. For ACP runners, the submit handler should send `/compact` as prompt text rather than calling `session.summarize()` directly. |
| 11 | `/fork` | **Show** | **Hide** | Fork dialog calls `sdk.session.fork()` — OpenCode-specific. ACP has `forkSession` RPC but the UI dialog assumes OpenCode session structure. |
| 12 | `/share` | **Hide** | **Hide** | Not needed in Claxedo (per product decision). |
| 13 | `/unshare` | **Hide** | **Hide** | Not needed in Claxedo (per product decision). |
| — | Custom commands | **Show** (from `sync.data.command`) | **Show** (from ACP `available_commands_update`) | Server-side commands come from the active runner. When runner is ACP, commands are advertised by the ACP agent. When runner is OpenCode, they come from the OpenCode command service. Already works correctly — `sync.data.command` reflects whichever backend is active. |

### Summary by action

| Action | Count |
|--------|-------|
| Show on both, no changes | `/new`, `/open`, `/steps` (3) |
| Show on both, scoped for ACP | `/model`, `/agent`, `/compact` (3) |
| OpenCode only | `/undo`, `/redo`, `/fork`, `/terminal`, `/mcp` (5) |
| Remove entirely (Claxedo) | `/share`, `/unshare` (2) |
| Deferred (ACP, needs separate subsystem) | `/mcp` centralized management (1) |

---

## Implementation details

### 1. Runner-aware filtering in `use-session-commands.tsx`

**Prerequisite:** `use-session-commands.tsx` does not currently import `useAcpConfig`
or `acpScope`. These must be wired in, following the pattern from the submit.ts
override:

```typescript
import { acpScope, useAcpConfig } from "@claxedo/claxedo-ui/context/acp-config"
import { base64Decode } from "@opencode-ai/util/encode"

// Inside useSessionCommands():
const acp = useAcpConfig()
const directory = () => params.dir ? base64Decode(params.dir) : undefined
const scope = () => acpScope({ directory: directory(), sessionId: params.id })
const isAcp = () => acp.isAcpMode(scope())
```

Commands that should be hidden for ACP runners should be omitted from the
registration when `isAcp()` is true. Use conditional array spreading, not
`disabled: true`, so they don't appear in the popover at all.

**Commands to gate on `!isAcp()`:**
- `session.undo` (slash: "undo")
- `session.redo` (slash: "redo")
- `session.fork` (slash: "fork")
- `terminal.toggle` (slash: "terminal") — keep keybind `ctrl+\`` for OpenCode, hide for ACP
- `mcp.toggle` (slash: "mcp") — deferred for ACP until centralized MCP subsystem exists

**Commands to remove entirely (both runners):**
- `session.share` (slash: "share")
- `session.unshare` (slash: "unshare")

### 2. Scoped `/model` for ACP runners

Current behavior: `/model` opens `DialogSelectModel` which shows all OpenCode
models from `sync.data.config.providers`.

Required behavior for ACP: Show only models from `acp.models(scope())` (the
`dynamicModels` array populated by `fetchConfigOptions()`). Selection calls
`acp.setModel(scope, modelId, input)`.

**Decision: Option A — create a dedicated `DialogSelectAcpModel` component.**

Rationale: The upstream `DialogSelectModel` consumes a `ModelState` object with
complex methods (`list()`, `visible()`, `current()`, `set()`, `variant`, etc.).
ACP config only provides `{id: string, name: string}[]`. Option B ("add a models
prop") would require either creating a full `ModelState` adapter or forking the
entire upstream component as an override — effectively the same duplication.
A small dedicated ACP model dialog reading from `useAcpConfig().models()` is
simpler and avoids coupling to the upstream component's interface.

File: `claxedo-app/src/claxedo-ui/components/dialog-select-acp-model.tsx`

The `/model` command's `onSelect` callback branches:
```typescript
onSelect: () => {
  if (isAcp()) {
    dialog.show(() => <DialogSelectAcpModel scope={scope()} />)
  } else {
    dialog.show(() => <DialogSelectModel />)
  }
}
```

### 3. Scoped `/agent` for ACP runners

Current behavior: `/agent` cycles through OpenCode agents via `local.agent.move(1)`.

Required behavior for ACP: Cycle through the runner's `availableModes`. The
modes come from the ACP `session/new` response.

**Prerequisite — add `availableModes` to `ScopeState` in `acp-config.ts`:**

The `ScopeState` type currently has `selectedAgent: string` but no mode list.
The ACP `session/new` response includes `availableModes` (confirmed in
`agent.ts:1154-1187`). This data needs to flow to the frontend:

1. Add `dynamicAgents: { id: string; name: string }[] | null` to `ScopeState`
2. Populate it during `fetchConfigOptions()` — extend the
   `/api/claxedo/agent-config/runner/options` response to include modes
   alongside models, or add a separate endpoint
3. Expose via `acp.agents(scope)` getter

**Implementation:** When `isAcp()`, the `onSelect` callback calls
`acp.setAgent(scope, nextMode)` instead of `local.agent.move(1)`. Cycling logic
iterates over `acp.agents(scope)`, advancing from the current `selectedAgent`
to the next in the list (wrapping around).

### 4. `/compact` routing for ACP runners

Current behavior: Calls `sdk.client.session.summarize()` directly.

Required behavior for ACP: Send `/compact` as text to the ACP agent, which
handles it in its prompt handler switch statement (`agent.ts:1469`).

**Decision: Call `sdk.session.prompt()` directly from `onSelect`.**

Neither "set editor text and auto-submit" nor "detect in submit handler" works
cleanly — `onSelect` has no access to the editor/submit mechanism, and builtin
slash commands are intercepted by the popover handler before reaching the submit
path. Instead, the `onSelect` callback calls `sdk.session.prompt()` directly
with `/compact` as the text part:

```typescript
onSelect: async () => {
  if (!params.id) return
  if (isAcp()) {
    await sdk.client.session.prompt({
      sessionID: params.id,
      parts: [{ type: "text", text: "/compact" }],
      model: { providerID: ..., modelID: ... },
      agent: local.agent.current()?.name ?? "default",
    })
  } else {
    // existing session.summarize() path
    await sdk.client.session.summarize({ ... })
  }
}
```

This bypasses the editor entirely and sends `/compact` as a prompt to the ACP
agent, which is exactly what the ACP handler expects.

### 5. `/mcp` for ACP runners — DEFERRED

**Out of scope for this task.** `/mcp` is gated behind `!isAcp()` for now.

The eventual ACP behavior requires a centralized MCP management subsystem:
- Workspace-level MCP config store (not per-process)
- New dialog UI for enabling/disabling MCP servers
- Integration with ACP session creation to inject `mcpServers` param

This is a separate feature requiring its own design doc. When built, `/mcp` will
be re-enabled for ACP runners by removing it from the `!isAcp()` gate and
routing to the centralized MCP dialog.

### 6. Custom commands for ACP runners

Custom commands (config, MCP prompts, skills) are **currently broken for ACP
sessions**. There are two problems: wrong command list source, and wrong
execution path.

#### Problem 1: Command list source is wrong

`sync.data.command` is populated from `GET /command` which calls
`adapter.listCommands()`. Both the OpenCode and ACP adapters return the same
thing — workspace-level commands from `~/.claxedo/opencode-config/command/*.md`
via `agent-config.ts:listCommands()`. These are Claxedo's local commands.

An ACP runner (Claude, Codex, Cursor) has its **own** commands from its own
MCP servers and configuration. The runner advertises these via
`available_commands_update` session notification, but workspace-runtime
**discards it** (`translate-session-update.ts:442` returns `[]`).

When OpenCode is the runner, OpenCode's `Command.list()` returns its commands
(built-in + config + MCP prompts + skills). But **OpenCode may not even be
running** when an ACP runner is selected — so `Command.list()` is unavailable.

#### Problem 2: Execution path is a no-op for ACP

The ACP adapter's `executeCommand()` (`acp.ts:1525`) is a no-op — it just logs
"not directly supported in ACP" and does nothing. The frontend calls
`POST /session/:id/command` → `adapter.executeCommand()` → nothing happens.

#### Existing plumbing

The workspace-runtime already has the right abstraction layer:

- **Routes** (`session-core.ts:412,442`): `GET /command` and
  `POST /session/:id/command` delegate to the adapter
- **Adapter interface** (`adapters/index.ts:92-93`): `listCommands(directory)`
  and `executeCommand(id, command, directory)`
- **OpenCode adapter** (`opencode.ts:497-507`): Forwards `executeCommand` to
  OpenCode server; `listCommands` returns workspace-level commands
- **ACP adapter** (`acp.ts:1525-1530`): Both are stubs

The fix lives in the ACP adapter — no new routes needed.

#### Required architecture

**Command list — the ACP adapter must return the runner's commands:**

| Runner | `adapter.listCommands()` returns | Source |
|--------|----------------------------------|--------|
| OpenCode | Workspace commands + OpenCode `Command.list()` from server | OpenCode process |
| ACP | Workspace commands + runner's advertised commands | `available_commands_update` cached in adapter state |

**Execution — the ACP adapter must forward commands as prompt text:**

| Runner | `adapter.executeCommand()` does |
|--------|--------------------------------|
| OpenCode | `POST /session/:id/command` to OpenCode server (current) |
| ACP | Send `/commandName args` as prompt text via ACP `session/prompt` to the runner |

#### Implementation

**Step 1 — Cache `available_commands_update` in ACP adapter state:**

The ACP adapter already caches `cachedConfigOptions` from
`config_option_update` (`acp.ts:322-325`). Apply the same pattern for commands:

```typescript
// acp.ts — alongside cachedConfigOptions:
cachedCommands: { name: string; description: string }[] | null = null

// In sessionUpdate handler (alongside config_option_update caching):
if (params.update?.sessionUpdate === "available_commands_update") {
  const cmds = (params.update as { availableCommands: ... }).availableCommands
  self.cachedCommands = cmds
  log.info("ACP sessionUpdate: cached commands", { count: cmds.length })
}
```

**Step 2 — Implement `listCommands()` in ACP adapter:**

```typescript
// acp.ts:1529 — replace stub:
async listCommands(directory: string): Promise<unknown[]> {
  const workspace = await listCommands()  // workspace-level from disk
  const runner = this.cachedCommands ?? []
  return [...workspace, ...runner]
}
```

**Step 3 — Implement `executeCommand()` in ACP adapter:**

Send the command as `/name` text to the ACP runner via `session/prompt`:

```typescript
// acp.ts:1525 — replace no-op:
async executeCommand(id: string, command: string, directory: string): Promise<void> {
  // Send as prompt text — ACP runners handle /commands in prompt text
  const input: PromptInput = {
    parts: [{ type: "text", text: `/${command}` }],
    // ... model/agent from session state
  }
  for await (const event of this.sendMessage(id, input, directory)) {
    // publish events same as normal prompt
  }
}
```

**Step 4 — Propagate `available_commands_update` to frontend:**

`translate-session-update.ts:442` — emit event so frontend can update the
slash popover when the runner's command list changes mid-session:

```typescript
case "available_commands_update": {
  return [{
    type: "commands-update",
    commands: update.availableCommands.map((c) => ({
      name: c.name,
      description: c.description,
    })),
  }]
}
```

**Step 5 — Frontend consumes `commands-update` event:**

The `commands-update` event flows through the existing event bus to the
frontend. `sync.data.command` (or a new `acp.commands(scope)` store) is updated
when this event arrives, so the slash popover reflects the runner's commands.

**No changes needed in `submit.ts` or `prompt-input.tsx`** — the existing
`POST /session/:id/command` → `adapter.executeCommand()` pipeline works once
the ACP adapter implements it. The frontend doesn't need to know which runner
is active; the adapter handles the routing.

---

## File inventory

| File | Change |
|------|--------|
| `claxedo-app/src/overrides/pages/session/use-session-commands.tsx` | Import `useAcpConfig` + `acpScope`. Add `isAcp()` helper. Gate undo/redo/fork/terminal/mcp behind `!isAcp()`. Remove share/unshare entirely. Branch model/agent/compact `onSelect` by runner type. |
| `claxedo-app/src/claxedo-ui/context/acp-config.ts` | Add `dynamicAgents: { id: string; name: string }[] | null` to `ScopeState`. Populate from runner options endpoint. Expose `agents(scope)` getter. |
| `claxedo-app/src/claxedo-ui/components/dialog-select-acp-model.tsx` | New component — simple model list dialog reading from `useAcpConfig().models()`. Calls `acp.setModel()` on selection. |
| `workspace-runtime/src/adapters/acp.ts` | Cache `available_commands_update` commands in adapter state. Implement `listCommands()` to return workspace + runner commands. Implement `executeCommand()` to send `/command` as prompt text to ACP runner. |
| `workspace-runtime/src/adapters/translate-session-update.ts` | Handle `available_commands_update` — emit `commands-update` event with `{name, description}[]` instead of returning `[]`. |

### Deferred (separate task)

| Item | Dependency |
|------|-----------|
| Centralized MCP config subsystem | Blocks `/mcp` for ACP runners. Needs own design doc. |

---

## Resolved decisions

1. **`/compact` routing mechanism**: Direct `sdk.session.prompt()` call from
   `onSelect` with `/compact` as text. See Implementation section 4.

2. **`/agent` mode list source**: Does not exist in frontend yet. Must add
   `dynamicAgents` to `ScopeState` and populate from runner options endpoint.
   See Implementation section 3.

3. **`/mcp` for ACP**: Deferred. Gated behind `!isAcp()` until centralized MCP
   subsystem is built. See Implementation section 5.

4. **`/model` dialog approach**: Option A — dedicated `DialogSelectAcpModel`
   component. See Implementation section 2.

5. **`/terminal` scoping**: Gated behind `!isAcp()` (not removed entirely).
   Keybind `ctrl+\`` preserved for OpenCode runner users.

## Remaining questions

1. **`/mcp` centralized config scope**: Is MCP configuration per-workspace,
   per-user, or per-runner-type? Needs separate design doc.

2. **`/fork` future enablement**: ACP has `forkSession` RPC. The UI dialog
   assumes OpenCode session structure. If fork is user-valued for ACP runners,
   what dialog adaptation is needed? Low priority — document the gap for future.

3. **Raw text submission of hidden commands**: What happens when a user types
   `/undo` or `/fork` directly as text (not via popover) in an ACP session?
   Currently it would be sent as a regular prompt. The ACP agent would not
   recognize it as a command and would treat it as a normal message. This is
   acceptable — no special handling needed.

4. **Keybind behavior for gated commands**: When commands like `/undo` are
   omitted from registration for ACP sessions, their keybinds also become
   inactive. This is correct behavior — the underlying operations don't work
   for ACP, so the keybinds should not fire either.
