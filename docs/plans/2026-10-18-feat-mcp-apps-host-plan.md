# Claxedo as an MCP Apps host

Status: P1 and P2 built on Pi; P3–P5 not started. Owner direction 2026-10-18: Claxedo supports MCP Apps as a standard, separate from agent-generated UI. Base: `dev`.

[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (SEP-1865, protocol `2026-01-26`, Stable; `@modelcontextprotocol/ext-apps` 2.0.3) lets an MCP tool declare a `ui://` HTML resource that the host draws in a sandboxed frame beside the tool call. The frame talks to the host over JSON-RPC on `postMessage`.

## Where this sits

| Mechanism | Producers | Owner |
|---|---|---|
| Sandboxed frame host speaking the MCP Apps bridge | third-party MCP Apps (this plan); later the plugin `custom-view` and agents' HTML fallback parts | this plan |
| Native surface renderer over one catalog | app plugins, agent reply surfaces | `2026-09-25-001-app-plugins-declarative-ui-plan.md` |

This plan builds the frame host for MCP Apps only. Its API takes a document, a policy and a set of handlers, so the other two callers reuse it without a second frame.

## Today (observed in code)

- **No harness passes MCP Apps information to Claxedo.**
  - `AgentToolPart` (`packages/agent-runtime-contract/src/content.ts`) has no field for the MCP server, the result's `_meta` or `structuredContent`.
  - `formatToolOutput` (`packages/session-core/src/projection/client-presentation/tool-output.ts:52-82`) flattens a tool result to its joined text and drops `structuredContent` and `_meta`.
  - `metadata` survives per call, and non-text content blocks already land in `metadata.acp.content` (`tool-lifecycle.ts:120-147`).
  - The harness contract has no MCP operation group (`packages/harness/src/contract/transport.ts:54-127`).
- **What each harness could give (evidence in Appendix A):**
  - **Pi:** Claxedo is the MCP client, through pi-mcp's `McpClient` (`listTools`, `readResource`, `callTool`).
  - **Codex:** its app-server protocol has `mcpServerStatus/list` (with `Tool._meta`), `mcpServer/resource/read` and `mcpServer/tool/call`. The wire `mcpToolCall` item already carries `mcpAppUi`, `mcpAppResourceUri` and `appContext`, which `mcpInput` drops (`packages/harness/src/transports/codex-app-server/translate/item-input.ts:49-51`).
  - **Claude Code:** the agent SDK 0.3.285 has `mcpServerStatus()` (tools' `_meta.ui`) and `readMcpResource(server, uri)`. Calling a tool outside a turn exists only as the `mcp_call` control request type, with no `Query` method.
  - **Cursor and OpenCode:** `_meta` is dropped inside the vendor SDK or engine, and neither exposes resource reads or tool calls.
  - **ACP:** 1.5.1 has no way to list, read or call on the agent's own MCP connections.
- **A server sends UI only to a client that asked for it.** Servers check the client's `capabilities.extensions["io.modelcontextprotocol/ui"]` (`mimeTypes: ["text/html;profile=mcp-app"]`) at `initialize`, and fall back to text without it. Whether each harness's MCP client advertises it is UNVERIFIED for Claude Code; Codex accepts it from its own client (t3code sets it on Codex's client capabilities); Pi advertises what Claxedo tells pi-mcp.
- **Frames:**
  - The desktop renderer's CSP is `frames: "none"` (`packages/claxedo-desktop/src/main/renderer-content-security.ts:32-40`), so no iframe draws on desktop today.
  - The web app allows `frames: "self"` (`packages/claxedo-app/vite.content-security-policy.ts`).
  - Plugin frames (`src/plugins/frame/`) are web-only, `sandbox="allow-scripts"` with `srcdoc`, and plugin-specific.
- **Storage:** there is no per-session file store. Tool-result attachments are inline data URLs in the transcript store, served by `GET /session/:id/message/:messageId/attachment/:attachmentId` (`packages/session-core/src/routes/session-core.ts:1109-1117`) through `toolImageResponse`, which serves images only. The hosted session-host has no `readAttachment`. Deleting a session removes its transcript rows, and so its inline attachments.
- **Theme:** `ThemeProvider` writes the tokens into `<style id="oc-theme">` (`packages/ui/src/theme/context.tsx:132-163`). The browser pane's `themeTokens()` and `watchTheme` (`src/browser/view/guest-theme.ts:13-46`) are the only code that pushes live tokens into a guest.
- **Reusable owners:**
  - confirmation: `requestConfirm` (`src/ui/confirm.tsx`);
  - links: `dispatchTranscriptLinkOpen` (`src/transcript/transcript-link.ts`), handled by `createTimelineLinkOpen`;
  - sending: `sendPrompt` (`src/session/transcript/send.ts`);
  - share levels: `sessionControls` (`src/access/model.ts`).

## Decisions for the owner

1. **Frame isolation on the web.** The spec requires web hosts to use a double iframe: a sandbox-proxy frame on an origin other than the app's, holding the app's frame. Desktop and native hosts may draw one sandboxed frame. t3code draws one `sandbox="allow-scripts allow-forms"` frame on a signed URL everywhere, which gives an opaque origin but not the spec's proxy.
   - **Proposed:** follow the spec. On the web, a proxy document served from a separate sandbox origin; on desktop, one sandboxed frame. P1 builds the single frame, and the proxy lands before hosted web ships apps.
   - **Owner input needed:** the sandbox origin for the hosted web app and for the local daemon's web UI.
   - **Built meanwhile:** one sandboxed `srcdoc` frame on both platforms (§4). It has an opaque origin and runs under the app's own network lock, so it reaches nothing the app itself could not; the proxy is still the spec's requirement for web hosts.
2. **When an app shows.**
   - **Proposed:** an app draws in place of its tool row and is never folded into the turn's work group. Its frame mounts only when the row scrolls into view and is torn down when the row unmounts or its session leaves the cache. The first page after a session switch paints text first, and the app document is fetched when the frame mounts. This is the same question as an agent reply surface in the plugin plan, and should get one answer.
3. **Who may drive an app** (shared sessions, `follow` / `send`).
   - **Proposed:**
     - every reader who can read the session sees the app;
     - an app's `ui/message` needs `send`, the same as the composer;
     - an app's `tools/call` is owner-only, because it runs on the owner's MCP connection, and `docs/reviews/2026-10-05-review-r2-server.md` P2 already reports a `send` member's turn getting owner-identity MCP.
4. **Cursor and OpenCode.**
   - **Proposed:** they show MCP App calls as ordinary tool rows. A Claxedo-side second MCP connection to their servers is not planned. It re-implements the harness's MCP client, against "layer over harnesses, never own internals", and breaks servers that keep per-connection state or OAuth sessions. It stays an open question until a user needs it.

## Design

### 1. The tool part carries MCP facts
- **Owner:** session-core's tool projection (`tool-lifecycle.ts`, `tool-output.ts`).
- **New field:** a completed or failed MCP tool part carries `metadata.mcp`:

  ```ts
  type ToolMcpFacts = {
    server: string
    tool: string
    resultMeta?: Record<string, unknown>
    structuredContent?: unknown
    app?: McpAppReference
  }

  type McpAppReference = {
    resourceUri: string
    csp?: McpAppCsp
    prefersBorder?: boolean
  }
  ```

  The types and their readers (`toolMcpFacts`, `mcpAppCsp`, `mcpToolVisibleTo`) live in `packages/agent-runtime-contract/src/mcp-app.ts`. The app document itself is the part's attachment with mime `text/html;profile=mcp-app` (§3), so the reference names no document. `permissions` is not read: the host grants none.

- **Text output:** `formatToolOutput` keeps producing the text for the model and the generic row.
- **Header reads:** every tool header keeps `metadata.mcp.{server, tool, app}` (`toolMcpHeader`), so a header-only read knows to draw the app's frame; the frame loads the part's body, attachment included, when it mounts.
- **Name:** the server is always in `metadata.mcp.server`, so no reader parses `mcp__server__tool` for it. The harness spellings stay as they are.

### 2. A harness MCP operation group
- **The group** joins the harness contract next to the existing ones, with three operations:
  - `listTools(server)`, returning each tool's `_meta` and `annotations`;
  - `readResource(server, uri)`, returning the contents with their `_meta`;
  - `callTool(server, tool, args)`, outside a turn.
- **A transport implements only what its harness offers.** A missing operation answers `unsupported`, and the app shows that operation as unavailable.
- **Per transport:**
  - **Pi:** wraps `PiMcpTools.clients` (`packages/harness/src/transports/pi-durable/mcp.ts:31`). It keeps `Tool._meta` (`mcp.ts:57-60`, `mcp-cache.ts:5`), returns `_meta` and `structuredContent` beside `toLlmContent` (`mcp.ts:96`), and advertises the extension at `initialize`.
  - **Codex:** `rpc.request("mcpServerStatus/list" | "mcpServer/resource/read" | "mcpServer/tool/call")`. `mcpInput` and `itemMetadata` forward `mcpAppUi`, `mcpAppResourceUri`, `appContext`, `result._meta` and `structuredContent`. The client capabilities advertise the extension.
  - **Claude Code:** `mcpServerStatus()` and `readMcpResource()`. `tool_use_result` is kept for `mcp__*` tools (`packages/harness/src/transports/claude-sdk/translate/tool-results.ts:61,107-131`). `callTool` answers `unsupported` until an `mcp_call` control request is proven to work through the SDK.
- **Hidden tools:** a tool whose `_meta.ui.visibility` lacks `"model"` must stay out of the agent's tool list. Only Pi lets Claxedo enforce this; for the others it is the harness's MCP client's behaviour, recorded per harness in Appendix A.

### 3. Capture: a snapshot of the app document
- **Trigger:** a completed MCP tool call whose tool declares `_meta.ui.resourceUri` (or the deprecated `_meta["ui/resourceUri"]`).
- **Steps:** the runtime calls `readResource` once on the same client, checks the mime type `text/html;profile=mcp-app` and the size, and stores the document as an inline `data:` attachment of that tool part (`mcp-app.html`). It keeps the resource's `_meta.ui` (`csp`, `prefersBorder`) in `metadata.mcp.app`. Pi carries both through the tool result's `details`, so a replayed session redraws the same app (`packages/harness/src/transports/pi-durable/mcp-app.ts`, `translate/tools.ts`).
- **Size cap:** 2 MiB of HTML, checked before decoding, so the base64 part fits the 5 MiB JSON body limit (`packages/session-core/src/routes/http.ts:10`) and the 16 MiB relay tunnel. This is a proposed number for the owner to confirm.
- **Timing:** capture runs after the tool part completes. The row draws as an ordinary tool row until the reference lands as a part update. A failed, oversized or wrong-type capture leaves the ordinary row and logs the reason.
- **Lifetime:** the snapshot is fixed at call time, so the transcript replays the same app after the server changes or goes away. Deleting the session deletes it with the transcript.

### 4. Drawing the document (built instead of a served route)
- **No route.** The document reaches the app with the part's body, so it is read under the session's own `message_read` authorization and needs no new origin, signed URL or attachment route.
- **Frame document:** a `srcdoc` holding only our `<meta>` Content-Security-Policy and a fixed bootstrap script (`src/mcp-apps/bootstrap.ts`). A `srcdoc` frame inherits the app's own policy, which refuses inline scripts, so the bootstrap's hash is in the shared `script-src` (`content-security-policy.ts`, the web and the desktop renderer policy). The host posts the HTML once after the frame's first `load`; the bootstrap adopts its head and body and recreates every script from a `blob:` URL in document order, then fires `DOMContentLoaded` and `load`.
- **Our policy:** `default-src 'none'`, `script-src` the bootstrap hash and `blob:`, inline styles, `data:` images, media and fonts, `connect-src 'none'`, `object-src`, `form-action` and `base-uri 'none'`, plus the resource's declared origins (only scheme-qualified, no wildcard, at most 32, each at most 256 characters).
- **Measured (Chromium 141, the production web and desktop policies):** classic and module scripts run in order; `eval`, inline event handlers and an undeclared `fetch` are refused; a declared outside origin is still refused by the inherited app `connect-src`, so an app reaches only what the network lock allows; the app's own CSP `<meta>` can only tighten. Details in `packages/claxedo-app/src/mcp-apps/README.md`.

### 5. The frame host (`packages/claxedo-app/src/mcp-apps/`, a new domain with its README)

| File | Owns |
|---|---|
| `frame.tsx` | the sandboxed iframe, lazy mount and teardown, one-frame-per-row lifecycle |
| `bridge.ts` | the JSON-RPC method table, request limits, inbound validation |
| `host-context.ts` | `hostContext` and its changes: theme, display mode, container size, locale, platform |
| `consent.ts` | which requests ask the reader, through `requestConfirm` |
| `view.tsx` | the transcript's MCP App row: title, frame, fullscreen control, unavailable states |

- **Theme:** `guest-theme.ts` keeps reading the theme for the browser pane. The reader of resolved tokens moves into one shared owner (`src/ui/theme-tokens.ts`), which both the browser pane and `host-context.ts` use. `host-context.ts` maps our tokens onto the spec's style variable names (`--color-background-primary`, `--color-text-primary`, `--color-border-primary`, `--font-sans`, `--font-mono`, `--border-radius-md` and the rest) and sends only the changes.
- **Accepted messages:** only those whose `event.source` is the frame's `contentWindow`. Each message is at most 256 KiB, with at most 16 requests in flight. Outbound messages go to `"*"`, because the frame's origin is opaque.
- **Navigation:** a second `load` event means the app navigated away. The host stops it, and the row says so.

**Bridge methods:**

| Method | Direction | Behaviour |
|---|---|---|
| `ui/initialize` → `ui/notifications/initialized` | app → host | Answers `protocolVersion: "2026-01-26"`, `hostInfo`, `hostCapabilities` (only what is implemented below), `hostContext`. Nothing is sent before `initialized`. |
| `ui/notifications/tool-input`, `tool-result` | host → app | Replayed once from the stored part after `initialized`. |
| `ui/notifications/tool-cancelled` | host → app | Sent when the part ended as interrupted or failed. |
| `ui/notifications/host-context-changed` | host → app | Theme, light/dark, display mode, container size; changed keys only. |
| `ui/notifications/size-changed` | app → host | Inline height, clamped to 80–2000 px, default 320. |
| `ui/open-link` | app → host | http(s) only, only with the frame focused and a user activation; opened through `dispatchTranscriptLinkOpen` on the frame element, so loopback links open in the browser pane as transcript links do. |
| `ui/message` | app → host | Text content only. Needs `send`. Always asks through `requestConfirm`, then sends with `sendPrompt` as the reader. |
| `tools/call` | app → host → server | Owner-only. The tool must exist and allow `"app"` visibility; a tool not marked `readOnlyHint` asks first, naming the server, the tool and the arguments. Runs through the harness group's `callTool`. |
| `resources/read` | app → host → server | Same server only, through `readResource`. |
| `ui/request-display-mode` | app → host | `inline` and `fullscreen`; fullscreen uses the same element in the top layer, so the app never reloads. Escape, a dialog or a request waiting on the reader returns it inline. |
| `ui/resource-teardown` | host → app | Sent before the frame is removed; waits at most 2 s. |
| `ping`, `notifications/message` | app → host | Answered and logged. |
| `ui/update-model-context` | app → host | Phase 4. |
| `tool-input-partial`, `pip`, `sampling`, `ui/download-file` | | Not offered; answered with method-not-found. |

### 6. Transcript integration
- **Renderer choice:** `ToolPartDisplay` (`src/transcript/message-part.tsx`) draws `McpAppView` when `metadata.mcp.app` is present, before `ClaxedoTool` and the registry. The view lives in `src/mcp-apps/`, since `message-part.tsx` is already 2185 lines.
- **Fold:** whatever Decision 2 settles, applied in `answerGroups` (`packages/agent-runtime-contract/src/turn-fold.ts`).
- **States the row draws:** loading (sized from the last reported height, or the default), running, stopped (navigated away), unavailable (the harness lacks an operation, or the session's runtime is asleep or stopped: interacting says to send a message first), and failed capture (the ordinary tool row).
- **Shared sessions:** a `follow` reader's app runs, but its `tools/call` and `ui/message` answer "not allowed" with no prompt.

### 7. Desktop
- **CSP:** the renderer's policy allows frames only from the app document's own attachment origin; every other frame stays blocked.
- **Isolation:** an e2e test proves the frame cannot reach `window.api` or the preload bridge, navigate the top window, or open windows.

### 8. Model context (Phase 4)
- **Storing:** `ui/update-model-context` stores one entry per session and tool call: text, plus `structuredContent` as JSON text, at most 16 KiB. Each call replaces the last one, and empty text removes it.
- **Delivering:** the next human send carries the entries as untrusted context. The owner of prompt assembly (session-core prompt admission) decides the shape: a quoted context part, never an instruction.

## Phases and acceptance

- [x] **P1. Contract, capture and frame on Pi (local).**
  - **Build:**
    - `metadata.mcp` with its header shape;
    - the harness MCP group for Pi;
    - capture and the attachment route for app documents;
    - `src/mcp-apps/` with the bridge rows marked P1: everything except `tools/call`, `ui/message` and model context;
    - the transcript row.
  - **Fixture:** a test MCP server serving one `ui://` app that reports its size, reads the theme and opens a link.
  - **Flows, desktop width and `phone`, each with a recorded red run:**
    - the app draws in place of the tool row and follows a light/dark switch;
    - it reloads identically after a page reload and after the fixture server is stopped;
    - a session switch paints the first page before any app document is fetched.
  - **Negative:**
    - an oversized and a wrong-mime resource leave the ordinary row;
    - a frame message from another window is ignored;
    - the app's `fetch` to an undeclared origin is blocked;
    - a navigating app is stopped.
  - Progress: built on Pi. Contract and header (`agent-runtime-contract/src/mcp-app.ts`); Pi advertises the extension, keeps `_meta` and `annotations`, hides model-hidden tools and captures the snapshot; the `mcp` operation group and its owner-only routes `GET /session/:id/mcp/:server/tools`, `POST …/tool-call`, `POST …/resource-read` (session-core `routes/session-mcp.ts`); the frame host `src/mcp-apps/` drawn in place of the tool row (`ToolPartDisplay`). Flow 62 (web and phone) proves the app paints the tool result and the host's colour scheme, repaints after a reload and after its server stops, and its red run (the resource served as `text/html`) leaves the ordinary row. Unit tests cover the oversized and wrong-mime captures, a message from another window, the in-flight and size limits, and navigation.
- [x] **P2. Interaction.**
  - **Build:** `tools/call` and `ui/message` with consent and share-level rules; fullscreen; `tool-cancelled`.
  - **Flows:**
    - a confirmed `tools/call` runs and its result reaches the app;
    - a declined one never reaches the server (asserted on the fixture server's call log);
    - a `readOnlyHint` tool runs without a prompt;
    - `ui/message` asks, and posts as the reader when allowed;
    - a `follow` reader's calls are refused without a prompt;
    - a `send` reader's `tools/call` is refused.
  - Progress: built. `tools/call` (owner only; a tool not marked `readOnlyHint` asks first), `ui/message` (needs `send`, always asks), fullscreen in the top layer, and `tool-cancelled`. Flow 62 proves a declined call never reaches the server (its call log) and a confirmed one returns into the frame; unit tests prove a `follow` reader and a `send` reader are refused without a prompt.
- [ ] **P3. Codex, then Claude Code.**
  - **Codex:** the `mcpInput` and metadata fields, the three `rpc.request` operations, and the client capability.
  - **Claude Code:** `mcpServerStatus`, `readMcpResource` and the kept `tool_use_result`; `callTool` answers `unsupported` until proven.
  - **Proof:** each harness passes the P1 and P2 flows it supports, against the same fixture server. A row in Appendix A records what each one does, with the flow that proves it.
  - Progress:
- [ ] **P4. Model context.** §8, with a flow: an app's note reaches the agent in the next turn and is gone after one empty update.
  - Progress:
- [ ] **P5. Web sandbox proxy** (if Decision 1 holds).
  - **Build:** the proxy document on the sandbox origin, with the `ui/notifications/sandbox-proxy-ready` / `sandbox-resource-ready` handshake, forwarding everything else.
  - **Flow:** the hosted web app draws the fixture app only through the proxy.
  - **Negative:** the proxy refuses a resource sent from any window other than its parent.
  - Progress:

## Definition of done
- [ ] Pi, Codex and Claude Code draw MCP Apps from any configured server on desktop and web; Cursor, OpenCode and ACP agents show ordinary tool rows. Appendix A matches the code.
- [ ] One frame host (`src/mcp-apps/`) and one theme-token reader; no second iframe implementation or theme mirror is added.
- [ ] Every app tool call that is not read-only, and every app message, asks the reader first; share levels hold; the declined paths are proven to reach nothing.
- [ ] An app keeps working from its snapshot after its server is gone, and goes away when its session is deleted.
- [ ] A session switch's first page paints before any app document loads.
- [ ] `bun run check`, `bun run typecheck` and `bun run test` in `packages/claxedo-app`; the harness, session-core and workspace-runtime suites (the last under the no-signal `sandbox-exec` profile); and `bun run test:architecture-ratchets` at the repo root pass on the merge tip. Every new or changed flow has a recorded red run, at desktop width and in `phone`.

## Execution
- **Parallel lanes, each owning its own files, in separate worktrees off `dev`:**
  - **contract and capture:** `packages/agent-runtime-contract` (`metadata.mcp`, header shape), `packages/session-core` (projection, capture, attachment route), `packages/workspace-runtime` attachment reads;
  - **harness group:** `packages/harness` contract and the Pi transport; Codex and Claude Code in P3 as two more lanes, one per transport folder;
  - **frame host:** `packages/claxedo-app/src/mcp-apps/`, `src/ui/theme-tokens.ts`, the `ToolPartDisplay` branch, desktop CSP;
  - **fixture and flows:** the test MCP server and `e2e/flows/`.
- **Contract first:** the contract lane lands `ToolMcpFacts` and the harness group's types first. The others build on them in parallel.
- **Machine limits:** at most two lanes run test suites at once, and one e2e stack at a time on this machine.

## Open questions
- The sandbox origin for hosted web and for the local daemon's web UI (Decision 1).
- Whether Claude Code's MCP client advertises `io.modelcontextprotocol/ui` to servers, and whether an `mcp_call` control request can be sent through the agent SDK.
- Whether OpenCode's engine exposes its internal MCP service to an embedding host (unverified), which would replace a second connection for that harness.
- Model-context delivery shape in prompt admission (§8).

## Appendix A: per-harness capability (2026-10-18, from the code)

| Harness | Tool-call facts reach Claxedo | List tools with `_meta` | Read resource | Call tool outside a turn | Drop points |
|---|---|---|---|---|---|
| Pi | name only | yes, Claxedo's own `McpClient` | yes | yes | `packages/harness/src/transports/pi-durable/mcp.ts:57-60`, `:96`; `mcp-cache.ts:5` |
| Codex | server, tool, arguments; result flattened | yes, protocol, unused | yes, protocol, unused | yes, protocol, unused | `packages/harness/src/transports/codex-app-server/translate/item-input.ts:49-51`, `:76-79`; `packages/session-core/src/projection/client-presentation/tool-output.ts:71` |
| Claude Code | name; text and images; `tool_use_result` used only for Task and question tools | yes, SDK, unused | yes, SDK, unused | control request type only | `packages/harness/src/transports/claude-sdk/translate/tool-results.ts:61`, `:107-131`; `system-message.ts:29-33` |
| Cursor | server and tool; text and images only | no | no | no | vendor SDK `McpSuccessSchema` |
| OpenCode | name only | no | no | no | engine `mcp/client.js:217-222`, `:288-315` |
| ACP | content blocks in `metadata.acp.content`; top-level `_meta` dropped | no | no | no | `packages/harness/src/transports/acp/translate/tool-presentation.ts:73-95` |
