# ACP → OpenCode Event Mapping

Authoritative reference for how every ACP protocol type maps to the OpenCode UI event format
used by `packages/workspace-runtime`. The goal is **100% feature parity** — every ACP signal
has a defined mapping. Where the OpenCode schema doesn't yet have a matching type, the required
extension is specified explicitly.

**SDK version:** `@agentclientprotocol/sdk` 0.16.1
**Last verified against:** `types.gen.d.ts` in the installed SDK

---

## Status legend

| Symbol | Meaning |
|---|---|
| ✅ COVERED | Implemented and correct |
| 🐛 BUG | Implemented but incorrectly |
| ❌ NOT IMPLEMENTED | Mapping defined here; code not written yet |
| 🔶 FRAGILE | Implemented but via an unsafe hack |
| ✂️ DROPPED | Intentionally not mapped (reason given) |

---

## Architecture: Two Translation Layers

```
ACP binary stdout (NDJSON)
        │
        ▼
 ClientSideConnection (SDK parses NDJSON, routes to Client handlers)
        │
        ├── sessionUpdate(SessionNotification)   ← notifications from agent
        │         │
        │         ▼
        │   [Layer 1]  translateSessionUpdate()
        │   SessionUpdate  →  UIMessageChunk[]
        │         │
        └── requestPermission(RequestPermissionRequest)  ← RPC from agent
                  │
                  ▼ (direct push, bypasses Layer 1)
                  UIMessageChunk { type: "permission-request" }

        │
        ▼ (all UIMessageChunks flow here)

   [Layer 2]  chunkToOpenCodeEvent()
   UIMessageChunk  →  OpenCodeEvent[]
        │
        ▼
   publishGlobalEvent()  →  SSE stream  →  Browser / OpenCode SDK
```

**Third signal** — after `session/prompt` resolves:
```
PromptResponse.stopReason  →  UIMessageChunk(s) emitted by sendMessage()
```

---

## Section 1 — Layer 1: ACP `SessionUpdate` → `UIMessageChunk`

`SessionUpdate` is a discriminated union on the `sessionUpdate` field. 11 variants total.

---

### 1.1 `agent_message_chunk` — PARTIAL

**ACP type:** `ContentChunk & { sessionUpdate: "agent_message_chunk" }`

```typescript
type ContentChunk = {
  content: ContentBlock
  messageId?: string | null   // UNSTABLE — UUID grouping chunks into one logical message
}

type ContentBlock =
  | { type: "text";          text: string; annotations? }
  | { type: "image";         data: string; mimeType: string; uri?; annotations? }
  | { type: "audio";         data: string; mimeType: string; annotations? }
  | { type: "resource_link"; uri: string; name: string; mimeType?; title?; description?; size?; annotations? }
  | { type: "resource";      resource: TextResourceContents | BlobResourceContents; annotations? }
```

**Mapping:**

| `content.type` | UIMessageChunk | Status | Notes |
|---|---|---|---|
| `"text"` | `{ type: "text-delta", delta: content.text }` | ✅ COVERED | |
| `"image"` | `{ type: "image-delta", mimeType, data }` | ❌ NOT IMPLEMENTED | Requires new chunk type + part type — see §5.1 |
| `"audio"` | `{ type: "audio-delta", mimeType, data }` | ❌ NOT IMPLEMENTED | Requires new chunk type + part type — see §5.2 |
| `"resource_link"` | `{ type: "resource-link-delta", uri, name, mimeType?, title? }` | ❌ NOT IMPLEMENTED | Requires new chunk type + part type — see §5.3 |
| `"resource"` (text) | `{ type: "text-delta", delta: resource.text }` | ❌ NOT IMPLEMENTED | Fold text resource into text-delta stream |
| `"resource"` (blob) | ✂️ DROPPED | ✂️ DROPPED | Binary blob in chat has no UI slot; skip |

**`messageId` tracking:** ❌ NOT IMPLEMENTED
A change in `messageId` (including from `null` to a UUID, or from one UUID to another)
signals the agent has started a new logical message within the same prompt turn. This should:
1. Emit `{ type: "step-start", newMessageId: string }` before the next content chunk.
2. The route handler updates its `assistantMsgId` to `newMessageId` so subsequent Layer 2
   events are attributed to the new message.

**Bug in current code:**
Guard `if (content?.type === "text" && content.text)` — the `&& content.text` part drops
empty-string deltas. Correct guard: `content?.type === "text"` only.

---

### 1.2 `agent_thought_chunk` — PARTIAL

**ACP type:** `ContentChunk & { sessionUpdate: "agent_thought_chunk" }`

Same structure as `agent_message_chunk`. Carries reasoning/thinking tokens.

| `content.type` | UIMessageChunk | Status |
|---|---|---|
| `"text"` | `{ type: "thinking-delta", delta: content.text }` | ✅ COVERED |
| `"image"` | `{ type: "image-delta", mimeType, data }` | ❌ NOT IMPLEMENTED |
| `"audio"` | ✂️ DROPPED | ✂️ DROPPED |
| `"resource_link"` | ✂️ DROPPED | ✂️ DROPPED |
| `"resource"` (text) | `{ type: "thinking-delta", delta: resource.text }` | ❌ NOT IMPLEMENTED |
| `"resource"` (blob) | ✂️ DROPPED | ✂️ DROPPED |

**Bug in current code:** Same `&& content.text` guard issue as §1.1.

---

### 1.3 `user_message_chunk` — ✂️ DROPPED

**ACP type:** `ContentChunk & { sessionUpdate: "user_message_chunk" }`

The agent echoes the user's submitted message back as content chunks.

**Decision: DROPPED permanently.**
The OpenCode UI creates the user message entry from the `PromptRequest` body before the
agent responds. Echoing it would create duplicate entries. This is not a parity gap.

**Output:** `[]`

---

### 1.4 `tool_call` — PARTIAL

**ACP type:** `ToolCall & { sessionUpdate: "tool_call" }`

```typescript
type ToolCall = {
  toolCallId: string              // required — unique within session
  title: string                   // required — human-readable e.g. "Reading src/main.ts"
  status?: ToolCallStatus         // initial status (usually "pending")
  kind?: ToolKind                 // category hint for UI icon
  locations?: ToolCallLocation[]  // file locations for follow-along
  content?: ToolCallContent[]     // initial content (rare at announce time)
  rawInput?: unknown              // raw tool params
  rawOutput?: unknown             // raw output (very rare at announce time)
}

type ToolKind = "read" | "edit" | "delete" | "move" | "search"
             | "execute" | "think" | "fetch" | "switch_mode" | "other"

type ToolCallLocation = { path: string; line?: number | null }
```

**Mapping:**

| Condition | UIMessageChunk(s) | Status |
|---|---|---|
| always | `{ type: "tool-start", toolCallId, toolName: title, kind? }` | ❌ NOT IMPLEMENTED — `kind` not currently passed through |
| `rawInput !== undefined` | + `{ type: "tool-input", toolCallId, input: rawInput }` | ❌ NOT IMPLEMENTED |
| `locations` present | + `{ type: "tool-location", toolCallId, locations }` | ❌ NOT IMPLEMENTED — requires new chunk type, see §5.4 |
| content has `type: "diff"` items | + `{ type: "file-diff", path, oldText?, newText }` per diff | ❌ NOT IMPLEMENTED |
| content has `type: "terminal"` item | + `{ type: "tool-terminal", toolCallId, terminalId }` | ❌ NOT IMPLEMENTED — requires new chunk type, see §5.5 |

**`kind` field:** Should be threaded through to `tool-start` so the UI can show the right
icon (file read vs terminal execute vs web fetch). Extend `tool-start` chunk to carry
`kind?: ToolKind`.

**Bug in current code:**
Cast `update as { toolCallId?: string; title?: string }` makes required fields optional.
Both are always present per the SDK type. The cast masks type errors.

**Guard for `rawInput`:**
Must use `rawInput !== undefined` — not `if (rawInput)` — since `0`, `false`, `""`, `null`
are all falsy but valid inputs.

---

### 1.5 `tool_call_update` — BUG + PARTIAL

**ACP type:** `ToolCallUpdate & { sessionUpdate: "tool_call_update" }`

```typescript
type ToolCallUpdate = {
  toolCallId: string                    // required
  title?: string | null                 // optional label update
  status?: ToolCallStatus | null        // new status
  kind?: ToolKind | null
  locations?: ToolCallLocation[] | null // replaces locations
  content?: ToolCallContent[] | null    // replaces content collection
  rawInput?: unknown                    // streaming input update
  rawOutput?: unknown                   // final result
}

type ToolCallContent =
  | { type: "content";  content: ContentBlock }
  | { type: "diff";     path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string }
```

**Mapping by `status`:**

| `status` | Current UIMessageChunk | Correct UIMessageChunk | Status |
|---|---|---|---|
| `"completed"` | `tool-output` | `tool-output` + `file-diff` per diff content item | PARTIAL |
| `"failed"` | `tool-output` (wrong) | `tool-error` | 🐛 BUG |
| `"in_progress"` + `rawInput` | nothing | `tool-input` | ❌ NOT IMPLEMENTED |
| `"in_progress"` + `locations` | nothing | `tool-location` update | ❌ NOT IMPLEMENTED |
| `"pending"` | nothing | nothing | ✅ DROPPED — no-op |
| `null` / `undefined` | nothing | nothing | ✅ DROPPED — no status change |

**Content items when `status === "completed"`:**

| `content` item type | UIMessageChunk | Status |
|---|---|---|
| `{ type: "diff", path, oldText?, newText }` | `{ type: "file-diff", path, oldText?, newText }` | ❌ NOT IMPLEMENTED |
| `{ type: "terminal", terminalId }` | `{ type: "tool-terminal", toolCallId, terminalId }` | ❌ NOT IMPLEMENTED — see §5.5 |
| `{ type: "content", content: ContentBlock }` | ✂️ DROPPED | ✂️ DROPPED — raw output carries the summary |

**Note on `file-diff` chunk shape:**
The ACP `Diff` type carries `{ path, oldText?, newText }` — the full text of both versions.
The current `file-diff` UIMessageChunk carries `{ path, patch: string }` (a pre-built
unified diff string). The chunk type should be updated to carry `{ path, oldText?, newText }`
directly, matching the ACP type, and let the Layer 2 / UI decide how to render it.

---

### 1.6 `plan` — 🐛 BUG

**ACP type:** `Plan & { sessionUpdate: "plan" }`

```typescript
type Plan = {
  entries: PlanEntry[]
}

type PlanEntry = {
  content: string           // ← the description field. NOT "title", NOT "description"
  status: PlanEntryStatus   // "pending" | "in_progress" | "completed"
  priority: PlanEntryPriority  // "high" | "medium" | "low"
  // NOTE: no `id` field. no `title` field. no `description` field.
}
```

**Current (buggy) mapping:**
```typescript
const todos = entries.map((e, i) => ({
  id: e.id ?? String(i),               // BUG: e.id doesn't exist
  description: e.title ?? e.description ?? "",  // BUG: both fields don't exist; always ""
  status: e.status ?? "pending",
}))
```

**Correct mapping:**
```typescript
{ type: "todo-update", todos: entries.map((e, i) => ({
  id: String(i),
  description: e.content,   // the actual field
  status: e.status,
  priority: e.priority,     // ❌ NOT IMPLEMENTED — add to todo-update chunk type
})) }
```

**`priority` field:** NOT IMPLEMENTED. The `todo-update` UIMessageChunk type currently has
`{ id, description, status }` — no `priority`. Add `priority?: "high" | "medium" | "low"`
to carry it through to the UI.

---

### 1.7 `available_commands_update` — ✂️ DROPPED

**ACP type:** `AvailableCommandsUpdate & { sessionUpdate: "available_commands_update" }`

```typescript
type AvailableCommandsUpdate = {
  availableCommands: Array<{ name: string; description: string; input?: { hint: string } | null }>
}
```

**Decision: DROPPED permanently.**
Slash commands are served via the `GET /command` REST endpoint. The agent advertises
available commands when the session starts; the frontend fetches once on session creation.
Real-time mid-session command list changes are not needed.

**Output:** `[]`

---

### 1.8 `current_mode_update` — ❌ NOT IMPLEMENTED

**ACP type:** `CurrentModeUpdate & { sessionUpdate: "current_mode_update" }`

```typescript
type CurrentModeUpdate = {
  currentModeId: string   // e.g. "general", "plan", "build", "explore"
}
```

**Mapping to OpenCode:** This is the agent selector. `currentModeId` maps directly to
OpenCode's agent concept. The agent can switch its own mode mid-session autonomously
(e.g., a "general" agent decides it needs to enter "plan" mode).

**New UIMessageChunk required:**
```typescript
{ type: "session-agent"; agentId: string }
```

**New OpenCode event required:**
```json
{
  "type": "session.agent",
  "properties": {
    "sessionID": "<sessionId>",
    "agentId": "plan"
  }
}
```

**`modeId` normalisation:** The ACP binary may use any string as a mode ID. When translating,
pass through the raw `currentModeId` as `agentId`. The UI already has the list of modes from
`NewSessionResponse.modes` — it can look up the display name by ID.

---

### 1.9 `config_option_update` — ❌ NOT IMPLEMENTED

**ACP type:** `ConfigOptionUpdate & { sessionUpdate: "config_option_update" }`

```typescript
type ConfigOptionUpdate = {
  configOptions: SessionConfigOption[]
}

type SessionConfigOption =
  | { type: "select";  id: string; name: string; category?: string; currentValue: string; options: SessionConfigSelectOptions }
  | { type: "boolean"; id: string; name: string; category?: string; currentValue: boolean }

// category: spec-defined values are "mode" | "model" | "thought_level" | string
```

**What this carries in practice (from claude-agent-acp):**
- `thought_level` (select): `none | low | high` — how much extended thinking is used
- `model` (select): current model being used within the session
- Mode-related toggles

**Mapping:** The agent reports its current runtime config. This lets the UI stay in sync
with config the agent may have auto-adjusted.

**New UIMessageChunk required:**
```typescript
{ type: "config-update"; options: Array<{
  id: string
  name: string
  category?: string
  type: "select" | "boolean"
  currentValue: string | boolean
  selectOptions?: Array<{ id: string; name: string }>
}> }
```

**New OpenCode event required:**
```json
{
  "type": "session.config",
  "properties": {
    "sessionID": "<sessionId>",
    "options": [
      { "id": "thought_level", "name": "Thinking", "category": "thought_level",
        "type": "select", "currentValue": "high",
        "selectOptions": [{"id": "none", "name": "Off"}, {"id": "low", "name": "Low"}, {"id": "high", "name": "High"}]
      }
    ]
  }
}
```

**Frontend use:** Render a live session settings panel. When the user changes a value,
call `POST /session/:id/config` → `conn.setSessionConfigOption()`.

---

### 1.10 `session_info_update` — ❌ NOT IMPLEMENTED

**ACP type:** `SessionInfoUpdate & { sessionUpdate: "session_info_update" }`

```typescript
type SessionInfoUpdate = {
  title?: string | null
}
```

**Mapping:** The agent renames the session mid-conversation (e.g., after understanding
what the user wants, it sets a meaningful title like "Refactor auth module").

**Two actions required:**
1. Update the SQLite `sessions` row: `UPDATE sessions SET title = ? WHERE id = ?`
2. Emit a new OpenCode event

**New UIMessageChunk required:**
```typescript
{ type: "session-title"; title: string }
```

**New OpenCode event required:**
```json
{
  "type": "session.updated",
  "properties": {
    "sessionID": "<sessionId>",
    "title": "Refactor auth module"
  }
}
```

---

### 1.11 `usage_update` — ❌ NOT IMPLEMENTED

**ACP type:** `UsageUpdate & { sessionUpdate: "usage_update" }` (UNSTABLE in SDK)

```typescript
type UsageUpdate = {
  size: number          // total context window size in tokens
  used: number          // tokens currently in use
  cost?: Cost | null    // { amount: number; currency: string }  e.g. { amount: 0.032, currency: "USD" }
}
```

**Mapping:** Live context window usage bar and cost display per session.

**New UIMessageChunk required:**
```typescript
{ type: "usage"; contextSize: number; contextUsed: number; cost?: { amount: number; currency: string } }
```

**New OpenCode event required:**
```json
{
  "type": "session.usage",
  "properties": {
    "sessionID": "<sessionId>",
    "contextSize": 200000,
    "contextUsed": 45230,
    "cost": { "amount": 0.032, "currency": "USD" }
  }
}
```

**Note:** The `cost` field is agent-reported and is separate from OpenCode's own cost model
(which is computed from model pricing tables). They may diverge. Source of truth decision:
use agent-reported cost for ACP sessions; use OpenCode's computed cost for OpenCode sessions.

---

## Section 2 — Out-of-Band: `requestPermission` Client Call

Not a `SessionUpdate`. The ACP agent calls this as a blocking RPC on the `Client` interface.

**ACP types:**

```typescript
type RequestPermissionRequest = {
  sessionId: string
  toolCall: ToolCallUpdate    // the tool needing permission
  options: PermissionOption[]
}

type PermissionOption = {
  optionId: string
  name: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

type RequestPermissionResponse = {
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string }
}
```

**Correct mapping (direct push, bypasses `translateSessionUpdate`):**

```typescript
push({
  type: "permission-request",
  requestId: permId,
  tool: params.toolCall.title ?? "unknown",
  paths: (params.toolCall.locations ?? []).map(l => l.path),
  options: params.options.map(o => ({ optionId: o.optionId, kind: o.kind, name: o.name })),
})
```

**UIMessageChunk — needs extension:**
```typescript
// Current:
{ type: "permission-request"; requestId: string; tool: string; paths: string[] }

// Required (add options so UI can offer all choices):
{ type: "permission-request"; requestId: string; tool: string; paths: string[];
  options: Array<{ optionId: string; kind: PermissionOptionKind; name: string }> }
```

**Current handling:** 🔶 FRAGILE — synthetic `tool_call_update` injection via listener
side-channel. Replace with direct push to stream queue.

**Response flow:**
1. Frontend receives `permission.asked` (Layer 2 maps the chunk).
2. User picks an option. Frontend calls `POST /permission/:id/respond`.
3. Current `decision` enum: `"allow_once" | "allow_always" | "deny"`.
   **Missing: `"reject_always"`** — add to the decision type.
4. `respondPermission()` maps decision → `PermissionOptionKind`:
   - `"allow_once"` → `"allow_once"`
   - `"allow_always"` → `"allow_always"`
   - `"deny"` → `"reject_once"`
   - `"reject_always"` → `"reject_always"` ❌ NOT IMPLEMENTED

**Layer 2 mapping of `permission-request` chunk:**
```json
{
  "type": "permission.asked",
  "properties": {
    "id": "<requestId>",
    "sessionID": "<sessionId>",
    "permission": "<tool>",
    "patterns": ["<path>"],
    "options": [{ "optionId": "...", "kind": "allow_once", "name": "Allow once" }]
  }
}
```

---

## Section 3 — Out-of-Band: `PromptResponse.stopReason`

After `conn.prompt()` resolves, `sendMessage()` receives `stopReason`.

```typescript
type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
```

**Correct mapping:**

| `stopReason` | UIMessageChunk(s) | Status |
|---|---|---|
| `"end_turn"` | `session-status idle` + `finish` | ✅ COVERED (falls through correctly) |
| `"max_tokens"` | `session-status idle` + `finish` | ✅ COVERED (falls through correctly) |
| `"max_turn_requests"` | `session-status idle` + `finish` | ✅ COVERED (falls through correctly) |
| `"refusal"` | `session-status error` + `error { error: "Request refused by agent" }` | ❌ NOT IMPLEMENTED |
| `"cancelled"` | `session-status idle` only — **no `finish`** | ❌ NOT IMPLEMENTED |

**Bug in current code:**
Checks `stopReason === "error"` which can never be true — `"error"` is not in `StopReason`.
Real errors are thrown as exceptions and caught by `.catch()`. The `.then()` guard is dead code.

---

## Section 4 — Layer 2: `UIMessageChunk` → `OpenCodeEvent`

`chunkToOpenCodeEvent()` translates each `UIMessageChunk` to zero or more `OpenCodeEvent`s.
The function signature should return `OpenCodeEvent[]` (not `OpenCodeEvent | null`) — some
chunks (e.g. `tool-output`) need to emit two events.

**Note on current side-effect bug:** The `tool-output` case currently calls
`publishGlobalEvent()` inline as a side effect, then returns the second event. This makes the
function impossible to unit test without mocking the module. The fix: return both events as
an array and let the caller publish them all.

---

### 4.1 `text-delta` → `message.part.updated` ✅ COVERED

```json
{ "type": "message.part.updated", "properties": {
  "sessionID": "...", "messageID": "<asmId>",
  "part": { "type": "text", "id": "<asmId>-text", "text": "<accumulatedText>" }
}}
```

`text` is **cumulative** (all deltas so far), not just the latest delta. Required for OpenCode
SDK coalescing — same `part.id` overwrites the previous value.

---

### 4.2 `thinking-delta` → `message.part.updated` ✅ COVERED

```json
{ "type": "message.part.updated", "properties": {
  "sessionID": "...", "messageID": "<asmId>",
  "part": { "type": "reasoning", "id": "<asmId>-thinking", "text": "<accumulatedThinkingText>" }
}}
```

Same accumulation pattern as text-delta.

---

### 4.3 `tool-start` → `message.part.updated` ✅ COVERED (kind field missing)

```json
{ "type": "message.part.updated", "properties": {
  "sessionID": "...", "messageID": "<asmId>",
  "part": {
    "type": "tool-use", "id": "<toolCallId>",
    "toolCallId": "<toolCallId>", "toolName": "<toolName>",
    "state": "pending",
    "kind": "<kind>"    ← ❌ NOT IMPLEMENTED — add once chunk carries kind
  }
}}
```

---

### 4.4 `tool-input` → `message.part.updated` ❌ NOT IMPLEMENTED

```json
{ "type": "message.part.updated", "properties": {
  "sessionID": "...", "messageID": "<asmId>",
  "part": {
    "type": "tool-use", "id": "<toolCallId>",
    "toolCallId": "<toolCallId>", "state": "pending",
    "input": <input>
  }
}}
```

---

### 4.5 `tool-output` → two `message.part.updated` ✅ COVERED (side-effect smell)

**Event 1** — update tool-use to complete:
```json
{ "type": "message.part.updated", "properties": {
  "part": { "type": "tool-use", "id": "<toolCallId>", "state": "complete" }
}}
```

**Event 2** — tool result:
```json
{ "type": "message.part.updated", "properties": {
  "part": { "type": "tool-result", "id": "<toolCallId>-result", "toolUseId": "<toolCallId>", "content": <output> }
}}
```

Both should be returned as an array, not via a side-effect `publishGlobalEvent()` call.

---

### 4.6 `tool-error` → two `message.part.updated` ❌ NOT IMPLEMENTED

**Event 1** — mark tool-use as errored:
```json
{ "type": "message.part.updated", "properties": {
  "part": { "type": "tool-use", "id": "<toolCallId>", "state": "error" }
}}
```

**Event 2** — error result:
```json
{ "type": "message.part.updated", "properties": {
  "part": { "type": "tool-result", "id": "<toolCallId>-result", "toolUseId": "<toolCallId>",
            "isError": true, "content": "<error message>" }
}}
```

---

### 4.7 `file-diff` → `message.part.updated` ❌ NOT IMPLEMENTED

**Requires new `diff` part type** — see §5.6.

```json
{ "type": "message.part.updated", "properties": {
  "sessionID": "...", "messageID": "<asmId>",
  "part": {
    "type": "diff",
    "id": "<toolCallId>-diff-<index>",
    "path": "src/foo.ts",
    "oldText": "original content",
    "newText": "modified content"
  }
}}
```

Carry the full `oldText`/`newText` from the ACP `Diff` type rather than pre-building a
unified diff patch string. Let the UI diff renderer compute the visual diff from the two
versions.

---

### 4.8 `step-start` → new message boundary ❌ NOT IMPLEMENTED

**Requires new `message.completed` event** — see §5.7.

When `step-start` fires, the route handler must:
1. Emit `message.completed` for the current `assistantMsgId`.
2. Update `assistantMsgId` to `step-start.newMessageId`.
3. Subsequent `text-delta`, `tool-start`, etc. events use the new `assistantMsgId`.

```json
{ "type": "message.completed", "properties": { "sessionID": "...", "messageID": "<oldAsmId>" } }
```

---

### 4.9 `image-delta` → `message.part.updated` ❌ NOT IMPLEMENTED

**Requires new `image` part type** — see §5.1.

```json
{ "type": "message.part.updated", "properties": {
  "part": { "type": "image", "id": "<asmId>-image-<index>", "mimeType": "image/png", "data": "<base64>" }
}}
```

---

### 4.10 `audio-delta` → `message.part.updated` ❌ NOT IMPLEMENTED

**Requires new `audio` part type** — see §5.2.

```json
{ "type": "message.part.updated", "properties": {
  "part": { "type": "audio", "id": "<asmId>-audio-<index>", "mimeType": "audio/mp3", "data": "<base64>" }
}}
```

---

### 4.11 `resource-link-delta` → `message.part.updated` ❌ NOT IMPLEMENTED

**Requires new `resource-link` part type** — see §5.3.

```json
{ "type": "message.part.updated", "properties": {
  "part": { "type": "resource-link", "id": "<asmId>-rl-<index>", "uri": "...", "name": "...", "mimeType": "..." }
}}
```

---

### 4.12 `tool-terminal` → `message.part.updated` ❌ NOT IMPLEMENTED

**Requires new `terminal` part type** — see §5.5.

```json
{ "type": "message.part.updated", "properties": {
  "part": { "type": "terminal", "id": "<toolCallId>-terminal", "ptyId": "<mappedPtyId>" }
}}
```

---

### 4.13 `tool-location` → `message.part.updated` ❌ NOT IMPLEMENTED

**Requires new `tool-location` part type** — see §5.4.

```json
{ "type": "message.part.updated", "properties": {
  "part": {
    "type": "tool-use", "id": "<toolCallId>",
    "locations": [{ "path": "src/foo.ts", "line": 42 }]
  }
}}
```

Can be folded into the `tool-use` part update — no new part type needed, just add `locations`
to the existing `tool-use` part shape.

---

### 4.14 `session-agent` → `session.agent` ❌ NOT IMPLEMENTED

**Requires new `session.agent` event** — see §5.8.

```json
{ "type": "session.agent", "properties": { "sessionID": "...", "agentId": "plan" } }
```

---

### 4.15 `config-update` → `session.config` ❌ NOT IMPLEMENTED

**Requires new `session.config` event** — see §5.9.

```json
{ "type": "session.config", "properties": {
  "sessionID": "...",
  "options": [{ "id": "thought_level", "type": "select", "currentValue": "high", ... }]
}}
```

---

### 4.16 `session-title` → `session.updated` ❌ NOT IMPLEMENTED

```json
{ "type": "session.updated", "properties": { "sessionID": "...", "title": "New title" } }
```

---

### 4.17 `usage` → `session.usage` ❌ NOT IMPLEMENTED

```json
{ "type": "session.usage", "properties": {
  "sessionID": "...", "contextSize": 200000, "contextUsed": 45230,
  "cost": { "amount": 0.032, "currency": "USD" }
}}
```

---

### 4.18 `permission-request` → `permission.asked` ✅ COVERED

```json
{ "type": "permission.asked", "properties": {
  "id": "<requestId>", "sessionID": "...",
  "permission": "<tool>", "patterns": ["<path>"],
  "options": [...]     ← ❌ options not yet passed through
}}
```

---

### 4.19 `todo-update` → `session.todo` ✅ COVERED (priority field missing)

```json
{ "type": "session.todo", "properties": {
  "sessionID": "...",
  "todos": [{ "id": "0", "description": "...", "status": "pending", "priority": "high" }]
}}
```

`priority` field: ❌ NOT IMPLEMENTED in chunk type.

---

### 4.20 `session-status` → `session.status` ✅ COVERED

```json
{ "type": "session.status", "properties": { "sessionID": "...", "status": { "type": "busy" } } }
```

---

### 4.21 `finish` → `session.idle` ✅ COVERED

```json
{ "type": "session.idle", "properties": { "sessionID": "..." } }
```

---

### 4.22 `error` → `session.error` ✅ COVERED

```json
{ "type": "session.error", "properties": { "sessionID": "...", "error": { "message": "..." } } }
```

---

### 4.23 `question` → `question.created` ✅ COVERED (OpenCode adapter only)

ACP adapter does not produce `question` chunks. Questions flow via `requestPermission`.
Exists for OpenCode adapter compatibility only.

---

### 4.24 `subagent-spawned` → ✂️ DROPPED

No ACP protocol mechanism produces this chunk. Dead type for the ACP adapter.

---

## Section 5 — Schema Extensions Required for 100% Parity

These are the new types that need to be added to `UIMessageChunk` (adapters/index.ts) and
to the OpenCode event model (global-event-bus.ts / frontend reducer) to achieve full coverage.

---

### 5.1 Image content in messages

**New UIMessageChunk:**
```typescript
{ type: "image-delta"; mimeType: string; data: string }  // base64 encoded
```

**New `message.part.updated` part type:**
```typescript
{ type: "image"; id: string; mimeType: string; data: string }
```

---

### 5.2 Audio content in messages

**New UIMessageChunk:**
```typescript
{ type: "audio-delta"; mimeType: string; data: string }
```

**New `message.part.updated` part type:**
```typescript
{ type: "audio"; id: string; mimeType: string; data: string }
```

---

### 5.3 Resource link in messages

**New UIMessageChunk:**
```typescript
{ type: "resource-link-delta"; uri: string; name: string; mimeType?: string; title?: string; description?: string }
```

**New `message.part.updated` part type:**
```typescript
{ type: "resource-link"; id: string; uri: string; name: string; mimeType?: string; title?: string }
```

---

### 5.4 Tool call location tracking

**Extend `tool-start` UIMessageChunk:**
```typescript
{ type: "tool-start"; toolCallId: string; toolName: string; kind?: ToolKind; locations?: Array<{ path: string; line?: number }> }
```

**No new OpenCode event needed** — fold `locations` into the `tool-use` part update:
```typescript
{ type: "tool-use"; id: string; ...; locations?: Array<{ path: string; line?: number }> }
```

---

### 5.5 Embedded terminal in tool result

**New UIMessageChunk:**
```typescript
{ type: "tool-terminal"; toolCallId: string; terminalId: string }
```

The `terminalId` is the ID issued by workspace-runtime when the ACP agent called
`createTerminal` on the `Client` interface. workspace-runtime must maintain a
`terminalId → ptyId` mapping (ACP terminal ID to internal PTY ID).

**New `message.part.updated` part type:**
```typescript
{ type: "terminal"; id: string; ptyId: string }
```

The frontend embeds a live PTY view using the PTY WebSocket endpoint.

**Note:** This requires workspace-runtime to implement the `createTerminal` client handler
and maintain the `terminalId → ptyId` map for the duration of the session.

---

### 5.6 File diff in message / tool result

**Update `file-diff` UIMessageChunk** (drop the `patch` string, use raw text):
```typescript
// Current (remove):
{ type: "file-diff"; path: string; patch: string }

// New:
{ type: "file-diff"; path: string; oldText?: string; newText: string }
```

**New `message.part.updated` part type:**
```typescript
{ type: "diff"; id: string; path: string; oldText?: string; newText: string }
```

The UI diff renderer computes the visual diff from `oldText`/`newText` directly.

---

### 5.7 Multi-message turn boundary

**Update `step-start` UIMessageChunk** to carry the new message ID:
```typescript
// Current:
{ type: "step-start" }

// New:
{ type: "step-start"; newMessageId: string }
```

**New OpenCode event:**
```json
{ "type": "message.completed", "properties": { "sessionID": "...", "messageID": "<previousAsmId>" } }
```

**Route handler change:** `prompt_async` tracks `assistantMsgId`. When a `step-start` chunk
arrives, it emits `message.completed` for the current ID then updates `assistantMsgId` to
`step-start.newMessageId` for all subsequent chunks in the same prompt turn.

---

### 5.8 Session agent / mode change

**New UIMessageChunk:**
```typescript
{ type: "session-agent"; agentId: string }
```

**New OpenCode event:**
```json
{ "type": "session.agent", "properties": { "sessionID": "...", "agentId": "plan" } }
```

---

### 5.9 Session config update

**New UIMessageChunk:**
```typescript
{ type: "config-update"; options: Array<{
  id: string; name: string; category?: string; type: "select" | "boolean"
  currentValue: string | boolean
  selectOptions?: Array<{ id: string; name: string }>
}> }
```

**New OpenCode event:**
```json
{ "type": "session.config", "properties": { "sessionID": "...", "options": [...] } }
```

---

### 5.10 Session title update

**New UIMessageChunk:**
```typescript
{ type: "session-title"; title: string }
```

**New OpenCode event:**
```json
{ "type": "session.updated", "properties": { "sessionID": "...", "title": "..." } }
```

**Side effect:** Also update the SQLite `sessions` row.

---

### 5.11 Token usage / cost

**New UIMessageChunk:**
```typescript
{ type: "usage"; contextSize: number; contextUsed: number; cost?: { amount: number; currency: string } }
```

**New OpenCode event:**
```json
{ "type": "session.usage", "properties": { "sessionID": "...", "contextSize": 200000, "contextUsed": 45230, "cost": { "amount": 0.032, "currency": "USD" } } }
```

---

### 5.12 `reject_always` permission option

**Extend `respondPermission` decision type:**
```typescript
// Current:
decision: "allow_once" | "allow_always" | "deny"

// New:
decision: "allow_once" | "allow_always" | "deny" | "reject_always"
```

**Mapping:** `"reject_always"` → `PermissionOptionKind: "reject_always"`.

---

### 5.13 `plan` priority field

**Extend `todo-update` UIMessageChunk:**
```typescript
// Current:
{ type: "todo-update"; todos: Array<{ id: string; description: string; status: string }> }

// New:
{ type: "todo-update"; todos: Array<{ id: string; description: string; status: string; priority?: "high" | "medium" | "low" }> }
```

---

## Section 6 — Coverage Summary

### Layer 1: ACP `SessionUpdate` → `UIMessageChunk`

| `sessionUpdate` | Condition | UIMessageChunk(s) | Status |
|---|---|---|---|
| `agent_message_chunk` | `content.type === "text"` | `text-delta` | ✅ COVERED |
| `agent_message_chunk` | `content.type === "text"`, empty string | `text-delta` with empty delta | 🐛 BUG (guard drops it) |
| `agent_message_chunk` | `content.type === "image"` | `image-delta` | ❌ NOT IMPLEMENTED |
| `agent_message_chunk` | `content.type === "audio"` | `audio-delta` | ❌ NOT IMPLEMENTED |
| `agent_message_chunk` | `content.type === "resource_link"` | `resource-link-delta` | ❌ NOT IMPLEMENTED |
| `agent_message_chunk` | `content.type === "resource"` (text) | `text-delta` | ❌ NOT IMPLEMENTED |
| `agent_message_chunk` | `content.type === "resource"` (blob) | _(none)_ | ✂️ DROPPED |
| `agent_message_chunk` | `messageId` changed | `step-start` + delta | ❌ NOT IMPLEMENTED |
| `agent_thought_chunk` | `content.type === "text"` | `thinking-delta` | ✅ COVERED |
| `agent_thought_chunk` | `content.type === "text"`, empty string | `thinking-delta` with empty delta | 🐛 BUG |
| `agent_thought_chunk` | `content.type === "image"` | `image-delta` | ❌ NOT IMPLEMENTED |
| `agent_thought_chunk` | non-image/non-text content | _(none)_ | ✂️ DROPPED |
| `user_message_chunk` | any | _(none)_ | ✂️ DROPPED (permanent) |
| `tool_call` | always | `tool-start` | ✅ COVERED |
| `tool_call` | `kind` present | `tool-start` with `kind` | ❌ NOT IMPLEMENTED |
| `tool_call` | `locations` present | `tool-location` update | ❌ NOT IMPLEMENTED |
| `tool_call` | `rawInput !== undefined` | + `tool-input` | ❌ NOT IMPLEMENTED |
| `tool_call` | content has `diff` items | + `file-diff` per diff | ❌ NOT IMPLEMENTED |
| `tool_call` | content has `terminal` item | + `tool-terminal` | ❌ NOT IMPLEMENTED |
| `tool_call_update` | `status === "completed"` | `tool-output` | ✅ COVERED |
| `tool_call_update` | `status === "completed"` + diff content | + `file-diff` per diff | ❌ NOT IMPLEMENTED |
| `tool_call_update` | `status === "completed"` + terminal content | + `tool-terminal` | ❌ NOT IMPLEMENTED |
| `tool_call_update` | `status === "failed"` | `tool-error` | 🐛 BUG (emits `tool-output`) |
| `tool_call_update` | `status === "in_progress"` + `rawInput` | `tool-input` | ❌ NOT IMPLEMENTED |
| `tool_call_update` | `status === "in_progress"` + `locations` | `tool-location` | ❌ NOT IMPLEMENTED |
| `tool_call_update` | `status === "pending"` or no status | _(none)_ | ✂️ DROPPED |
| `plan` | always | `todo-update` | 🐛 BUG (`PlanEntry.content` not accessed) |
| `plan` | `priority` field | not in chunk | ❌ NOT IMPLEMENTED |
| `available_commands_update` | any | _(none)_ | ✂️ DROPPED (permanent) |
| `current_mode_update` | any | `session-agent` | ❌ NOT IMPLEMENTED |
| `config_option_update` | any | `config-update` | ❌ NOT IMPLEMENTED |
| `session_info_update` | any | `session-title` | ❌ NOT IMPLEMENTED |
| `usage_update` | any | `usage` | ❌ NOT IMPLEMENTED |
| unknown variant | any | _(none)_ | ✂️ DROPPED (future-proof) |
| `requestPermission` (Client RPC) | always | `permission-request` | 🔶 COVERED but fragile |
| `requestPermission` | `reject_always` option | decision type extended | ❌ NOT IMPLEMENTED |
| `PromptResponse.stopReason` | `"end_turn"` / `"max_tokens"` / `"max_turn_requests"` | `session-status idle` + `finish` | ✅ COVERED |
| `PromptResponse.stopReason` | `"cancelled"` | `session-status idle` (no finish) | ❌ NOT IMPLEMENTED |
| `PromptResponse.stopReason` | `"refusal"` | `session-status error` + `error` | ❌ NOT IMPLEMENTED |

### Layer 2: `UIMessageChunk` → `OpenCodeEvent`

| UIMessageChunk | OpenCodeEvent type(s) | Status |
|---|---|---|
| `text-delta` | `message.part.updated` (text, cumulative) | ✅ COVERED |
| `thinking-delta` | `message.part.updated` (reasoning, cumulative) | ✅ COVERED |
| `image-delta` | `message.part.updated` (image part) | ❌ NOT IMPLEMENTED |
| `audio-delta` | `message.part.updated` (audio part) | ❌ NOT IMPLEMENTED |
| `resource-link-delta` | `message.part.updated` (resource-link part) | ❌ NOT IMPLEMENTED |
| `tool-start` | `message.part.updated` (tool-use, state=pending) | ✅ COVERED |
| `tool-input` | `message.part.updated` (tool-use with input) | ❌ NOT IMPLEMENTED |
| `tool-location` | `message.part.updated` (tool-use with locations) | ❌ NOT IMPLEMENTED |
| `tool-output` | `message.part.updated` (tool-use state=complete) + (tool-result) | ✅ COVERED (side-effect smell) |
| `tool-error` | `message.part.updated` (tool-use state=error) + (tool-result isError) | ❌ NOT IMPLEMENTED |
| `tool-terminal` | `message.part.updated` (terminal part with ptyId) | ❌ NOT IMPLEMENTED |
| `file-diff` | `message.part.updated` (diff part) | ❌ NOT IMPLEMENTED |
| `step-start` | `message.completed` + new messageID for subsequent events | ❌ NOT IMPLEMENTED |
| `session-agent` | `session.agent` | ❌ NOT IMPLEMENTED |
| `config-update` | `session.config` | ❌ NOT IMPLEMENTED |
| `session-title` | `session.updated` | ❌ NOT IMPLEMENTED |
| `usage` | `session.usage` | ❌ NOT IMPLEMENTED |
| `permission-request` | `permission.asked` | ✅ COVERED |
| `question` | `question.created` | ✅ COVERED (OpenCode adapter only) |
| `todo-update` | `session.todo` | ✅ COVERED |
| `session-status` | `session.status` | ✅ COVERED |
| `subagent-spawned` | _(none)_ | ✂️ DROPPED |
| `finish` | `session.idle` | ✅ COVERED |
| `error` | `session.error` | ✅ COVERED |

---

## Section 7 — Known Bugs (fix before implementing new features)

| # | Location | Bug | Impact |
|---|---|---|---|
| 1 | `acp.ts:translateUpdate` | `plan` entries read `e.title ?? e.description` — `PlanEntry` has neither; only `e.content` | All todo descriptions are `""` in production |
| 2 | `acp.ts:translateUpdate` | `tool_call_update` `status === "failed"` emits `tool-output` not `tool-error` | Failed tools look like successful completions |
| 3 | `acp.ts:requestPermission` | Synthetic `tool_call_update` via listener side-channel | Fragile, untestable |
| 4 | `acp.ts:sendMessage` | `stopReason === "error"` check is dead code; `"refusal"` and `"cancelled"` treated as normal end | Wrong UI state on refusal/cancel |
| 5 | `acp.ts:translateUpdate` | `agent_thought_chunk` guard `&& content.text` drops empty-string deltas | Minor — empty reasoning tokens dropped |
| 6 | `acp.ts:translateUpdate` | `plan.entries` maps `e.id ?? String(i)` — `PlanEntry` has no `id` | Masks type error; no runtime impact |
| 7 | `global-event-bus.ts` | `tool-output` case calls `publishGlobalEvent()` as side effect inside `chunkToOpenCodeEvent()` | Function not unit-testable |

---

## Section 8 — Schema Extensions Summary

New types required across the codebase. Each extension is in §5.

| § | What to add | Where |
|---|---|---|
| 5.1 | `image-delta` UIMessageChunk + `image` part type | `adapters/index.ts` + event schema |
| 5.2 | `audio-delta` UIMessageChunk + `audio` part type | `adapters/index.ts` + event schema |
| 5.3 | `resource-link-delta` UIMessageChunk + `resource-link` part type | `adapters/index.ts` + event schema |
| 5.4 | `tool-location` UIMessageChunk; extend `tool-use` part with `locations` + `kind` | `adapters/index.ts` + event schema |
| 5.5 | `tool-terminal` UIMessageChunk + `terminal` part type; `terminalId → ptyId` map in ACPProcess | `adapters/index.ts` + event schema |
| 5.6 | `file-diff` chunk shape change (`patch` → `oldText/newText`); new `diff` part type | `adapters/index.ts` + event schema |
| 5.7 | `step-start` carries `newMessageId`; new `message.completed` event; route handler tracks current `asmId` | `adapters/index.ts` + event schema + `routes/session.ts` |
| 5.8 | `session-agent` UIMessageChunk + `session.agent` event | `adapters/index.ts` + event schema |
| 5.9 | `config-update` UIMessageChunk + `session.config` event | `adapters/index.ts` + event schema |
| 5.10 | `session-title` UIMessageChunk + `session.updated` event + SQLite update | `adapters/index.ts` + event schema + `acp.ts` |
| 5.11 | `usage` UIMessageChunk + `session.usage` event | `adapters/index.ts` + event schema |
| 5.12 | `"reject_always"` added to `respondPermission` decision type | `adapters/index.ts` + `routes/session.ts` |
| 5.13 | `priority` field added to `todo-update` todos array | `adapters/index.ts` |
