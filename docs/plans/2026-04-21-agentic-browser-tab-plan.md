---
title: Agentic Browser Tab (Electron webview + CDP + element-comment-to-chat)
type: feat
status: active
date: 2026-04-21
deepened: 2026-04-21
origin: null  # no brainstorm doc; planned directly from user request after parallel research across opencode + ~/test/superset-terminal-ref
references:
  - ~/test/superset-terminal-ref (browser-pane prior art, different codebase)
  - packages/claxedo-app/src/claxedo-ui/components/review-workspace.tsx (comment-on-diff precedent)
  - packages/claxedo-desktop/src/main/windows.ts (Electron host this feature plugs into)
  - packages/claxedo-server/src/claxedo-mcp/server.ts (agent-tool surface)
---

# Agentic Browser Tab

## Overview

Add a new first-class `"browser"` tab type to claxedo-app that embeds a live web page inside the existing group/tab/split layout, backed by Electron's native `<webview>` in `packages/claxedo-desktop`. Give the AI agent three capabilities on that page, each modelled on a seam that already exists in this repo:

1. **Read the running tab's console logs** — via CDP `Runtime.consoleAPICalled` + `Log.entryAdded` + `Runtime.exceptionThrown` on the webview's `webContents.debugger`, buffered in the main process, queryable and streamable by MCP tools.
2. **Take a screenshot and attach it to the chat** — via CDP `Page.captureScreenshot`, normalized into the existing `ImageAttachmentPart` / dataURL pipeline, pushed into the bound session's prompt composer.
3. **Pick a DOM element, attach a comment, send to chat** — click-to-inspect overlay generates a stable CSS selector, captures a cropped screenshot of the element, composes an annotation via the existing `LineCommentEditor`, and ships it through the existing `pane-bus` `comment:produce → comment:receive` flow the review workspace already uses for git-diff comments.

No git-worktree provisioning is part of this feature (the user clarified during planning that the "new worktree" phrasing in the original request was loose; browser tabs open like any other tab and inherit the focused group's worktree scope).

## Problem Frame

The product intent is an **agentic browser tab**: a place where the user lands a page, and the AI agent can see the page as the user sees it and act on specific parts of it. Today, agent ↔ running-UI feedback is a dead zone:

- Users who want the agent to react to a runtime bug in their app must paste a stack trace or a screenshot by hand.
- The only "comment on a specific thing" primitive in the product is the review-workspace diff comment. It has no analog for running UI.
- The desktop shell (`claxedo-desktop`) is an Electron app but has never embedded a sibling page. That affordance is dormant; this feature lights it up.

The superset-terminal-ref repo solved exactly this (native `<webview>` + Puppeteer CDP + MCP tools) — its architecture is the reference, but its implementation runs in a different monorepo with a different tab model, layout engine, and chat contract, so it cannot be ported file-for-file. This plan maps the superset primitives onto opencode's SolidJS tab/group/pane-bus/prompt-context surface.

## Requirements Trace

- **R1. New tab type `"browser"`** opens as a regular tab in the focused group, alongside session/terminal/file/review.
- **R2. The tab embeds a live web page** via Electron `<webview>`, with address bar, back/forward/reload, and history.
- **R3. The tab can load any URL** — first-party (user's dev server on localhost or sandbox preview), third-party, or a workspace-local `http://` URL. No cross-origin restrictions beyond those the target imposes.
- **R4. The AI agent can read the page's console logs** (log/warn/error/debug + uncaught exceptions), with time, level, args, and stack.
- **R5. The AI agent can take a screenshot** of the current tab and emit it as a chat image attachment.
- **R6. The user can click-select a DOM element** on the page, attach a free-text comment, and send that annotation to the bound chat session. The chat receives (a) a natural-language note describing the element and comment, (b) a cropped screenshot of the element, (c) structured metadata (selector, bounding box, URL) recoverable on the receiving side.
- **R7. Comment routing mirrors the review workspace**: the browser pane registers `comment:produce`, pane-bus `autoBind`s to a sibling `comment:receive` session pane in the same tab. If none exists or multiple candidates exist, the user picks via the existing kebab UI.
- **R8. The feature is opt-in** behind an environment/setting flag while webview embedding and CDP attach are hardened — no shipping enablement for users who don't ask for it.

## Scope Boundaries

- **Not shipping:** Cloud/web iframe-based browser tab, gateway CSP/COEP rewriting, service-worker header patching. This plan is Electron-native only (`packages/claxedo-desktop`).
- **Not shipping:** Per-browser-tab git worktree provisioning. The phrase "new worktree" in the original request was clarified by the user as non-essential. Browser tabs inherit their group's worktree like every other tab type does.
- **Not shipping:** A persistent SQLite browser history DB (superset-terminal-ref has one; opencode's existing `Persist.global/scoped` wrapper with localStorage is sufficient for v1 and avoids a new DB migration path).
- **Not shipping:** Agent-driven **writing** to the page (click, type, navigate triggered by the LLM). MCP tools will include `browser_click` / `browser_type_text` / `browser_navigate` as **read-and-act** primitives for agent loops, but the first user-facing v1 delivers *read*: logs, screenshots, element comments. Action tools land in the same phase but are not on the critical path for the marquee UX.
- **Not shipping:** Webview in the non-desktop (`claxedo-web`) client. Web users see the tab type as disabled / "requires desktop".
- **Not shipping:** Multi-tab coordination from the agent (e.g. "open a browser tab, wait for it to load, then screenshot"). The agent operates on whichever browser tab the user has open and bound; orchestration primitives can follow.
- **Not shipping:** Cookie / session isolation per browser tab. All browser tabs share the Electron app's default session partition; a future `"persist:user-<id>"` partition is left as a follow-up.

## Context & Research

### Relevant code and patterns

**Tab / group / pane layout (target)**
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/types.ts:3-15` — `TabType` union. Add `"browser"` here.
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/types.ts:19-47` — `TabItem` shape. Browser-specific fields land as optional fields (`browserId`, `currentUrl`, `pageTitle`, `isLoading`).
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/types.ts:121-156` — `PaneContent` union; add `BrowserPaneContent`.
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/tab-actions.ts:21-597` — `createTabActions` factory; add `addBrowserTab(url?, title?)` alongside `addTerminal` and `addFile`.
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/tab-type-registry.ts:1-50` — lifecycle hooks registry. Currently live-but-unused; the browser tab will be its first real caller (`onClose` detaches CDP + destroys webContents binding, `onReopen` recreates, `mergeDedupeKey = browserId`).
- `packages/claxedo-app/src/claxedo-ui/components/multi-pane/multi-pane-tab.tsx:19-267` — lazy-init branch to add for `"browser"`.
- `packages/claxedo-app/src/claxedo-ui/components/multi-pane/generic-leaf-node.tsx:752-996` — the `<Switch>` dispatch on `PaneContent.type`; add a new `<Match when={content().type === "browser"}>` case.
- Terminal-in-splits lifecycle (MEMORY.md "Terminal cross-group isolation" + `overrides/components/session/terminal-*`) is the blueprint for keeping the webview DOM element alive across group moves / splits / focus changes. Don't reinvent; mirror it.

**Electron host (extend)**
- `packages/claxedo-desktop/src/main/windows.ts:60-96` — `webPreferences` on the two `BrowserWindow`s. `webviewTag: true` is NOT currently set. Flip it (guarded by the same feature flag as the UI) so `<webview>` tags in the renderer actually materialize.
- `packages/claxedo-desktop/src/main/ipc.ts` — IPC surface root; add `browser:*` channels here.
- `packages/claxedo-desktop/electron.vite.config.ts:40` — preload entry; extend `window.claxedo.browser` on the preload bridge.
- No existing CDP / Puppeteer / debugger integration exists in opencode (grep confirmed). This feature introduces the first `webContents.debugger.attach("1.3")` call.

**Agent tool surface**
- `packages/claxedo-server/src/claxedo-mcp/server.ts:1-14` — stdio MCP server. Add new `browser_*` tools here, co-located with `council`, `tab_context`, `get_logs`, etc.
- `packages/claxedo-server/src/claxedo-mcp/server.ts:32-55` — `httpRequest` helper; the pattern for new tools to hit opencode-server routes via env-provided `OPENCODE_API_URL`.
- New agent tools live in the MCP server and call into the Electron main process via a small purpose-built bridge (see Unit 4).
- `packages/opencode/src/server/routes/instance/experimental.ts:134-219` — `/experimental/tool` and `/experimental/tool/ids` are the agent's own tool registry (upstream, read-only).

**Review-comment contract (precedent to mirror)**
- `packages/claxedo-app/src/claxedo-ui/components/review-workspace.tsx:635-661` — `handleLineComment` is the exact flow the browser-element-comment will clone.
- `packages/claxedo-app/src/claxedo-ui/context/pane-bus.ts:22-30, 286-325` — `CommentPayload` shape + `sendComment` dispatcher. Extend `CommentPayload` with a discriminated union so `"file"` (existing review flow) and a new `"page-element"` variant coexist.
- `packages/app/src/context/prompt.tsx:41-49` — `FileContextItem` is currently the only `ContextItem` variant. Widening this union lives in `packages/app` (upstream). Use an `@/` override at `packages/claxedo-app/src/overrides/context/prompt.tsx` to add `ElementContextItem` without forking upstream.
- `packages/app/src/utils/comment-note.ts:26-88` — `createCommentMetadata` / `formatCommentNote` hardcode "lines X through Y of PATH". Override at `packages/claxedo-app/src/overrides/utils/comment-note.ts` to dispatch on `origin === "browser"` vs. the existing origins; keep the existing signature for review comments.
- `packages/app/src/components/prompt-input/build-request-parts.ts:91-201` — emits a synthetic text part + file part for each comment context item. Override at `packages/claxedo-app/src/overrides/components/prompt-input/build-request-parts.ts` to additionally emit an `ImageAttachmentPart` for `ElementContextItem` screenshots.
- `packages/ui/src/components/line-comment.tsx:178-330` — `LineCommentEditor`. Reusable as-is for the element-comment composer: the `selection` prop is a `JSX.Element`, so we pass `<ElementSelectionChip selector={...} />` instead of a line-range chip.

**Image attachment pipeline (reuse wholesale)**
- `packages/app/src/components/prompt-input/attachments.ts:11-71` — `dataUrl(file, mime)` + `add(file)`. A screenshot produced by CDP (`base64PNG`) becomes a `File` via `new Blob([...]) → new File([...])` and goes through `attachments.add(file)` like any pasted image.
- `packages/app/src/context/prompt.tsx:30-36` — `ImageAttachmentPart`. Reuse unchanged.

### Institutional learnings

(From `~/.claude/projects/-Users-yashvardhansingh-test-opencode/memory/MEMORY.md` + codebase notes — no `docs/solutions/` exists in this repo.)

- **Never use `<Show>` to toggle an expensive panel** — it unmounts the subtree and causes 800ms+ jank. A live `<webview>` is by far the most expensive DOM node in the app; any visibility toggle uses CSS `display: none` + `hidden` class, mirroring `overrides/pages/session/session-side-panel.tsx`.
- **Terminal-in-splits cross-group isolation pattern** — multiple `*ContentWrapperInner` instances coexist (route-level + per-group); the browser tab clones this verbatim: route-level wrapper owns creation, per-group wrappers just link + render.
- **`wrapProviders` breaks ownership if it evaluates JSX before wrapping** — mirror `DirectoryScope`'s `iife`-around-child-wrap pattern if a `BrowserScope` provider is introduced.
- **`on(ready, ...)` in effects** — explicit deps, not implicit store-property tracking. Use this for all CDP-subscription setup/teardown effects.
- **`Persist.scoped(dir, id, ...)`** is per-session; a browser tab may have no session, so persist browser-tab state keyed by `(directory, tabId)` via `Persist.global` with legacy key support.
- **`registerTabType` is wired but unused** — browser tab is the first real caller; confirm `onMergeDrop` and `mergeDedupeKey` fire end-to-end in a split-merge before relying on them.
- **`feedback_no_duct_tape.md`** — before shipping, verify CDP domains (`Runtime`, `Page`, `Log`, `Overlay`, `DOM`) each work against the exact Electron version in `claxedo-desktop`; Electron's embedded Chromium is sometimes a release behind and drops methods.

### External references

(Verified via context7 or official docs at plan time; cited where they will anchor real decisions.)

- **Electron `<webview>` tag** — deprecated in the main-window sense but still supported when `webPreferences.webviewTag: true` is set. Runs the guest page in a separate process, isolated from the host renderer. Documentation: https://www.electronjs.org/docs/latest/api/webview-tag.
- **Electron `webContents.debugger.attach(protocolVersion)`** — attaches to the guest's CDP endpoint without Puppeteer or remote-debugging-port exposure. Receives events via `debugger.on("message", (event, method, params) => …)`. Sends commands via `debugger.sendCommand(method, params)`. Documentation: https://www.electronjs.org/docs/latest/api/debugger.
- **CDP `Overlay.setInspectMode`** with mode `"searchForNode"` triggers the native Chromium element picker on the target, highlights on hover, emits `Overlay.inspectNodeRequested({ backendNodeId })` on click. Works on every origin. Documentation: https://chromedevtools.github.io/devtools-protocol/tot/Overlay/#method-setInspectMode.
- **CDP `Page.captureScreenshot`** returns base64 PNG/JPEG. Supports `clip: { x, y, width, height, scale }` for cropped element captures. Documentation: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot.
- **CSS-selector stability** — selector generation: prefer `[data-testid]` → `#id` → `tag.class` chain with `:nth-of-type` fallback. Rocicorp `getCssSelector`, Chrome DevTools' own selector generator, and Selenium IDE all converge on this ordering. Reference: https://github.com/fczbkk/css-selector-generator.

### Related prior plans in this repo

- `docs/plans/2026-04-13-pane-local-frontend-orchestration-plan.md` — explains the per-group renderer pattern this feature hooks into.
- `docs/plans/2026-04-10-agent-hooks-consolidation-plan.md` — relevant if the feature adds long-running CDP sessions; reuse its agent-status conventions.
- `MEMORY.md` "Split Workspace Feature" — the definitive summary of per-group worktree / terminal-in-splits patterns we inherit.

## Key Technical Decisions

| Decision | Rationale |
|---|---|
| **Electron `<webview>` tag, not `BrowserView` or `WebContentsView` or in-app iframe.** | `<webview>` gives per-tab process isolation, mounts as a DOM node (so the group/split layout, portal-host pattern, and split-drag UX all work unchanged), and supports `webContents.debugger.attach` cleanly. `BrowserView` is deprecated in Electron 30+; its replacement `WebContentsView` is the officially supported path but requires renderer→main RPC on every layout tick to sync manual bounds, which would degrade split-drag performance on a live page. We accept that Electron's security guidance currently says "we recommend to not use `<webview>`" (https://www.electronjs.org/docs/latest/api/webview-tag) and mitigate via a strict `will-attach-webview` allowlist (see partition decision below) + a documented migration target: if Electron ever removes `<webview>`, we port to `WebContentsView` with `ResizeObserver`-driven bounds syncing. |
| **CDP via `webContents.debugger` — not Puppeteer.** | Puppeteer adds a 20+MB dependency and a parallel CDP client. `webContents.debugger` is built into Electron, exposes the same protocol, and is session-safe (sendCommand serializes per session so parallel MCP calls can't corrupt state). Superset-terminal-ref uses Puppeteer; we skip that tax. Trade-off: we inherit Electron's debugger quirks directly (crash reattach, cross-origin frame-host swap, DevTools conflict) — addressed in Unit 3's state machine. |
| **MCP↔main-process bridge via a NEW local HTTP listener in the Electron main, NOT an extension of `claxedo-desktop/src/main/server.ts`.** | Verification during deepening revealed `server.ts` is a sidecar-CLI spawner + health-checker, not an HTTP server. The plan must introduce a new listener in main (Hono-on-Node or `node:http`), bound to `127.0.0.1` only, on an ephemeral port. MCP speaks HTTP already; IPC is not reachable from a stdio subprocess. Alternative (route through claxedo-server) was rejected because claxedo-server cannot call Electron IPC either — only main-process code can talk to `webContents.debugger`. |
| **Per-launch shared secret minted at main-process boot, injected into MCP via env at spawn.** | Verification confirmed no existing `CLAXEDO_DESKTOP_TOKEN` / desktop↔gateway shared secret exists. Must be built. Token is `crypto.randomUUID()` at main boot, written to `window.api.browser.__internal.token` preload slot and to the MCP subprocess env (`CLAXEDO_DESKTOP_TOKEN` + `CLAXEDO_DESKTOP_URL`) via the existing spawn hook in opencode-server. Token travels in a **custom request header** (browsers cannot set custom headers on cross-origin `fetch` without CORS preflight, which the server never grants), not a cookie. Origin-header allowlist rejects every non-MCP caller. Rotating the token requires MCP restart. |
| **Mandatory `will-attach-webview` allowlist + dedicated `persist:agent-browser` partition.** | Default Electron lets the embedder's HTML set `nodeintegration` / `preload` / `webpreferences` on `<webview>` — historic CVE-2018-1000136, CVE-2020-4077 precedents. Main-process `will-attach-webview` strips every dangerous attribute, forces `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and pins the partition to `persist:agent-browser` (one partition for all agent-browser tabs; NOT the host-UI session, NOT shared with the user's real browser). Any `<webview>` with a different partition is rejected. This closes the cookie-bleed threat and the embedder-attribute-injection threat simultaneously. |
| **`browser_evaluate_js` + any write-side agent tool is per-tab opt-in + origin allowlist; NOT default-available.** | `Runtime.evaluate` on a page where the user has a valid session is equivalent to a malicious browser extension: read mail on gmail.com, move money on the user's bank, exfiltrate cookies. Prompt injection from page content makes "agent-driven arbitrary JS" a concrete threat, not a hypothetical. V1 ships with a per-tab toggle ("Allow agent to run JS on this tab", off by default) **and** a workspace-settings origin allowlist (default: `localhost`, `127.0.0.1`, user's own dev previews). Tool returns a legible denial otherwise. Every agent-initiated `browser_evaluate_js` / `browser_screenshot` / `browser_navigate` call is logged visibly in the chat transcript as an "agent performed X" entry — the single highest-leverage defense against silent prompt-injection exploitation. |
| **Widen `ContextItem` via `@/` override (EDIT, not create), not by adding a second context store.** | `packages/claxedo-app/src/overrides/context/prompt.tsx` already exists (293 lines) and owns `ContextItem` today. Unit 6 edits this file in place to add `ElementContextItem`. Review code paths continue to compile unchanged because `FileContextItem` remains a valid variant. Trade-off acknowledged: widening upstream's type via an override is upstream-sync fragile; mitigation is a characterization test in claxedo-app that pins the override's shape against upstream's `FileContextItem` and fails loudly on any upstream rename. |
| **Pane-bus introduces NEW `page-comment:produce` / `page-comment:receive` capabilities; does not overload `comment:produce` / `comment:receive`.** | Reconsidered during deepening. Overloading existing capabilities with a wider payload hides the variant from the capability type — future consumers registering for "comments" would silently receive page-element payloads they can't render. A distinct capability pair preserves the opt-in contract pane-bus was designed around, leaves review consumers 100% untouched, and still reuses `sendComment` dispatcher internals + autoBind + kebab-picker UX. Session panes that want both variants register for both capabilities. |
| **Formatted note lives on the payload at the producer; no override of `packages/app/src/utils/comment-note.ts`.** | Reconsidered during deepening. Overriding `formatCommentNote` changes dispatch shape for review callers too — their regressions wouldn't show up in browser tests. Instead, the browser pane's `handleElementComment` computes the final note string locally (using a new `formatElementCommentNote` helper that lives in claxedo-app only) and stores it directly on the `ElementContextItem.noteText`. The only real serialization boundary we override is `build-request-parts.ts`. Shrinks the override surface from three files to two and eliminates merge risk on upstream utilities. |
| **Screenshots ride the existing `ImageAttachmentPart` path + hard size caps.** | Chat already renders images and serializes them as data-URL file parts. A parallel binary upload through the gateway would add TTL/refresh, size limits, and WebSocket plumbing the project has never needed. Trade-offs acknowledged: base64 is +33% vs binary, modern 1440p page screenshots are 2–4 MB PNG → ~3–5 MB base64 → non-trivial fraction of provider context; JSON.stringify spikes memory; provider-side logs are out of user reach. **Enforced caps:** per-image 1 MB (JPEG re-encode if over), per-message 4 images, provider-4xx turned into legible in-UI errors rather than silent drops. |
| **Two feature-flag gates, not one.** | Verification showed claxedo-app uses build-time `VITE_*` flags (`VITE_SANDBOX_ENABLED`, etc.) while claxedo-desktop main uses runtime `CLAXEDO_*` env. Main-process gate `CLAXEDO_ENABLE_BROWSER_TAB` controls `webviewTag: true` + `will-attach-webview` registration + new HTTP listener start; renderer gate `VITE_CLAXEDO_ENABLE_BROWSER_TAB` controls tab-type registration and the `mod+shift+b` command. Both must be co-set; `windows.ts:injectGlobals` is the bridge if runtime propagation ever becomes preferable to two env vars. |
| **No git-worktree provisioning inside this feature.** | User clarified "new worktree" in the original ask was loose language. Tabs inherit their group's worktree via the existing `onAdd` hook. If a power user wants a browser tab on a fresh worktree, they create the worktree first (existing flow) and open the browser tab in that group. |

## Open Questions

### Resolved during planning

- **Runtime: cloud iframe or desktop webview?** → Desktop Electron webview + CDP (confirmed with user).
- **Target URL source: dev server only, URL bar, or both?** → Any URL: first-party, third-party, local (confirmed with user).
- **Tab placement: new split group or just a new tab?** → Just a new tab in the focused group. No worktree/split acrobatics (confirmed with user).
- **Comment delivery target: bound session, auto-create session, or embedded agent?** → Bound sibling session via pane-bus, exactly like review (confirmed with user) — but via a NEW `page-comment:*` capability pair, not by overloading `comment:*`.
- **Do we fork superset's Puppeteer setup?** → No; `webContents.debugger` is built-in and sufficient.
- **Do we add a new `ContextItem` variant or co-opt `FileContextItem`?** → New variant (`ElementContextItem`) by **editing** the existing `overrides/context/prompt.tsx` (verification showed the file already exists and owns `ContextItem`).
- **Do we need a new gateway route for the MCP↔main-process bridge?** → No. MCP tools hit a new `127.0.0.1`-bound HTTP listener inside the Electron main process, auth'd by a per-launch token in a custom header.
- **`<webview>` vs `WebContentsView` for v1?** → `<webview>` despite Electron's "not recommended" stance. Reason: `WebContentsView` requires main-process RPC per layout tick, degrading split-drag UX on a live page. Migration target documented. Mitigation for Electron's deprecation path: strict `will-attach-webview` hardening + pinned `persist:agent-browser` partition + scheduled Electron-version review each major bump.
- **Shared-secret source for MCP↔main-process HTTP?** → Per-launch random token minted by main at boot, injected to MCP via env at MCP subprocess spawn. Token is not persisted; rotation = restart.
- **Selector-generator library vs hand-rolled?** → `@medv/finder` (v4.x, ~1.5KB, actively maintained in 2026). Configured with `data-testid` / `data-test` / `data-cy` priority, id/class rejecter for CSS-in-JS prefixes (`css-`, `sc-`, `jsx-`, `_module_`), `:nth-of-type` last-resort fallback.

### Deferred to implementation

- **Console log ring-buffer size + eviction policy.** Start with 2,000 entries / tab; tune after running against a noisy app.
- **Element-selector robustness ceiling.** The picker emits a CSS selector and a backend node ID; the natural-language note in chat uses the selector, but we may also store the `backendNodeId` for short-lived follow-up tools. Decide at implementation time based on whether `backendNodeId` survives navigation (it doesn't — but tree-structured refs might). Shadow-DOM open roots traversed via `DOM.getDocument({ pierce: true })`; closed roots unsupported (emit composite `{ host, shadow }` path if needed).
- **Exactly which Electron version of CDP** claxedo-desktop currently ships (`40.4.1` per package.json at time of writing). Pin the protocol version at `"1.3"` initially; feature-probe via `Schema.getDomains` on first attach; log-and-degrade if any required domain is missing.
- **Recovery behavior when the guest webview crashes** (`webContents.on("render-process-gone", …)`). Show an error overlay and a reload button; exact copy and retry cap deferred.
- **Whether the element comment surfaces a per-comment screenshot or the full-page screenshot.** Start with a cropped element screenshot (clip = element boundingBox plus 16px padding). If the element is tiny, fall back to full viewport. Boundary: deferred to UX during implementation.
- **Idle-detach policy** (detach debugger on hide > N minutes). Phase 4 item; default N = 5.
- **registerTabType global-state antipattern.** The repo's layout-engine RFC (`docs/layout-engine-group-rendering-rfc.md`) flags `registerTabType`'s global mutable registry as a pattern to move away from. Browser tab becomes the first real caller, which locks it in. Open question whether to migrate to the RFC's successor pattern first or accept the short-term antipattern.

## High-Level Technical Design

> *This section illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Component / process topology

```
+----------------------------------------------------------------------------+
|                         CLAXEDO-DESKTOP (Electron main)                    |
|                                                                            |
|   +-------------------+    +-------------------------+                     |
|   |  BrowserRegistry  |<-->|  per-webContents CDP    |                     |
|   |  paneId -> wc     |    |  Runtime/Page/Log/      |                     |
|   |                   |    |  Overlay/DOM attaches   |                     |
|   +---------+---------+    +-----------+-------------+                     |
|             ^                          |                                   |
|             | IPC (browser:*)          | captureScreenshot /               |
|             |                          | consoleAPICalled /                |
|             |                          | inspectNodeRequested              |
|             v                          v                                   |
|   +---------+---------+    +-----------+-------------+                     |
|   |  IPC main handler |    |  Local HTTP: /browser/* |<-- MCP tools        |
|   +---------+---------+    +-------------------------+    (stdio server,   |
|             |                                              separate proc)  |
+-------------|--------------------------------------------------------------+
              |
       preload bridge
              |
              v
+----------------------------------------------------------------------------+
|                  CLAXEDO-APP (SolidJS renderer)                            |
|                                                                            |
|   +---------------------------+                                            |
|   | ClaxedoLayout store       |   tabs: [ ..., { type:"browser", ... } ]   |
|   | groups / split / tabs     |                                            |
|   +------------+--------------+                                            |
|                |                                                           |
|                v                                                           |
|   +---------------------------+    +-------------------------+             |
|   | BrowserPane component     |<-->|  <webview> DOM node     |             |
|   | - address bar             |    |  (guest Chromium proc)  |             |
|   | - nav controls            |    +-------------------------+             |
|   | - element picker overlay  |                                            |
|   | - console drawer          |                                            |
|   +------------+--------------+                                            |
|                |                                                           |
|                | comment produce                                           |
|                v                                                           |
|   +---------------------------+                                            |
|   | pane-bus `comment:*`      |---> bound session pane                     |
|   | (existing, extended)      |     -> prompt.context.add                  |
|   +---------------------------+     -> on submit, build-request-parts      |
|                                     -> text part + image part              |
+----------------------------------------------------------------------------+
```

### User flow: "open a browser tab, comment on a DOM element, send"

```
User ──▶ cmd+shift+b / kebab "New browser tab"
     └─▶ tabs.addBrowserTab(defaultURL?, title?)
         └─▶ ClaxedoLayout store adds TabItem{ type:"browser" }
             └─▶ GroupContentRenderer mounts <BrowserPane/>
                 └─▶ BrowserPane mounts <webview src=defaultURL>
                     └─▶ webview 'dom-ready' -> ipc.invoke("browser:register", paneId, wcId)
                         └─▶ main process: BrowserRegistry.register(paneId, wc)
                             └─▶ wc.debugger.attach("1.3")
                                 └─▶ enable Runtime, Page, Log, Overlay
                                     └─▶ subscribe consoleAPICalled -> push to ring buffer

User ──▶ clicks "Inspect" in BrowserPane
     └─▶ ipc.invoke("browser:setInspectMode", paneId, true)
         └─▶ main: wc.debugger.sendCommand("Overlay.setInspectMode", { mode:"searchForNode", highlightConfig:{...} })
             └─▶ (user hovers page; native Chromium highlight)
             └─▶ user clicks element
                 └─▶ main receives "Overlay.inspectNodeRequested" { backendNodeId }
                     └─▶ main: DOM.describeNode({ backendNodeId }) -> { nodeId, nodeName, attributes, ... }
                     └─▶ main: compute selector (data-testid > id > tag.class:nth-of-type chain)
                     └─▶ main: DOM.getBoxModel -> border box
                     └─▶ main: Page.captureScreenshot({ clip: box + padding }) -> base64 PNG
                     └─▶ main emits "browser:nodeSelected" event to paneId
                 └─▶ renderer receives { selector, boundingBox, pageUrl, screenshotDataUrl, outerHTML }

Renderer ──▶ opens LineCommentEditor (reused) with <ElementSelectionChip/> + screenshot preview
     └─▶ user types comment, hits submit
         └─▶ BrowserPane.handleElementComment(payload)
             ├─▶ browserComments.add(payload)                     // local persistence
             └─▶ prompt.context.add({ type:"page-element", ... }) // extended via override
                 └─▶ effect detects new context item
                     └─▶ sendComment(leafId, payload) via pane-bus
                         └─▶ bound session's onComment -> prompt.context.add(payload)

User ──▶ clicks send in the bound session
     └─▶ sendFollowupDraft -> buildRequestParts (overridden)
         ├─▶ for item.type === "page-element":
         │     ├─▶ text part: "The user commented on element <selector> at <url>: <comment>"
         │     │              + metadata.opencodeComment = { origin:"browser", selector, boundingBox, pageUrl, ... }
         │     └─▶ image part: { mime:"image/png", url: dataUrl, filename:"element-<shortHash>.png" }
         └─▶ client.session.promptAsync({ parts })
```

### Data-model extensions (directional, not final)

```
// types.ts union, new literal
type TabType = ... | "browser"

// types.ts, new pane-content variant
type BrowserPaneContent = BasePaneContent & { type: "browser"; browserId: string; initialUrl?: string }

// pane-bus.ts, CommentPayload becomes a discriminated union
type CommentPayload =
  | FileCommentPayload                // existing review flow
  | {
      type: "page-element"
      pageUrl: string
      selector: string
      boundingBox?: { x; y; width; height }
      outerHTML?: string
      screenshotDataUrl?: string
      comment?: string
      commentID?: string
      commentOrigin?: "browser"
    }

// overrides/context/prompt.tsx
type ContextItem = FileContextItem | ElementContextItem
type ElementContextItem = { type: "page-element"; pageUrl; selector; boundingBox?; outerHTML?; screenshotDataUrl?; comment?; commentID?; commentOrigin?: "browser" }

// Preload bridge: extends existing window.api (NOT window.claxedo — verified during deepening).
// Stream pattern is callback + unsubscribe (matches existing onSqliteMigrationProgress / onMenuCommand in preload/index.ts), NOT async iterator.
window.api.browser = {
  register(paneId, webContentsId) -> Promise<{ ok: true; browserId: string }>
  unregister(paneId) -> Promise<void>
  navigate(paneId, url) -> Promise<void>
  getConsoleLogs(paneId, { since?, level?, limit? }) -> Promise<ConsoleEntry[]>
  onConsoleEntry(paneId, cb) -> () => void                // unsubscribe
  captureScreenshot(paneId, opts?) -> Promise<{ dataUrl: string }>
  evaluate(paneId, expression) -> Promise<{ result: unknown; error?: { message; stack? } }>
  setInspectMode(paneId, enabled) -> Promise<void>
  onNodeSelected(paneId, cb) -> () => void                // unsubscribe
  setAgentAllowed(paneId, allowed: boolean) -> Promise<void>   // per-tab eval-js opt-in toggle
}

// Debugger attach state machine (per webContents):
//   Detached → Attaching → Attached(domains=[Runtime, Page, Log, Overlay, DOM, Target])
//   transitions:
//     dom-ready           -> attach + Target.setAutoAttach({ flatten: true }) + enable domains
//     did-navigate (main) -> re-enable domains, resubscribe Target.setAutoAttach to capture swapped RFH
//     render-process-gone -> clear subscriptions, reattach on next dom-ready
//     debugger 'detach' event (e.g. user opened DevTools) -> mark Detached, retry on DevTools-closed event
//     destroyed           -> detach (try/catch), unregister
```

## Implementation Units

- [ ] **Unit 1: Layout plumbing for the new tab type**

**Goal:** Let a `"browser"` tab exist in the ClaxedoLayout store, dispatch to a placeholder renderer, and be addable via a new `addBrowserTab` action and a keyboard shortcut.

**Requirements:** R1.

**Dependencies:** None.

**Files:**
- Modify: `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/types.ts` (add `"browser"` to `TabType`, extend `TabItem` with optional `browserId` / `currentUrl` / `pageTitle` / `isLoading`, add `BrowserPaneContent` to `PaneContent`).
- Modify: `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/tab-actions.ts` (add `addBrowserTab(url?, title?)`, add prefix entry `browser:` in `prefix(tab)`).
- Modify: `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/tab-type-registry.ts` caller — create `packages/claxedo-app/src/claxedo-ui/register-tabs.ts` if needed, called from the app entry point. Register `"browser"` with `onClose` / `onReopen` / `mergeDedupeKey: browserId`.
- Modify: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/multi-pane-tab.tsx` (lazy-init branch for `"browser"` in the `createEffect` that seeds `multiPane` state).
- Modify: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/generic-leaf-node.tsx` (new `<Match when={content().type === "browser"}>` dispatching to `<BrowserPane/>` placeholder).
- Create: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-browser.tsx` (minimal shell for now: address bar + an empty `<div class="webview-host"/>`).
- Create: `packages/claxedo-app/src/claxedo-ui/claxedo-layout-actions/browser-actions.ts` (exports `handleNewBrowserTab(groupId?, url?)` mirroring `handleNewSession` shape).
- Modify: wherever keyboard shortcuts are registered (search `mod+` in `packages/claxedo-app/src/`); add `mod+shift+b` → `handleNewBrowserTab`.
- Test: `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout.test.ts` (extend; add cases for `addBrowserTab`, dedupe by `browserId`, reopen last closed browser tab).

**Approach:**
- `addBrowserTab` follows `addTerminal` verbatim in shape: dedupe → generate `browserId: uuid()` → `tabActions.add({ type: "browser", scope: "directory", directory: focusedDir, browserId, title: title ?? "Browser", closable: true })` → `setActive(id)`.
- The placeholder `<BrowserPane/>` does nothing agent-facing yet; it exists so lay-out-level tests pass before the Electron host work starts.

**Execution note:** Start with the claxedo-layout.test additions as characterization tests before modifying the store — the store tests are the most likely thing to regress.

**Patterns to follow:**
- `handleNewSession` (`session-actions.tsx:64-125`) — one-for-one template for `handleNewBrowserTab`.
- `addTerminal` in `tab-actions.ts` — dedupe + prefix + add.

**Test scenarios:**
- Opening a browser tab twice with no URL creates two distinct tabs (no dedupe on "empty" browsers).
- Opening a browser tab with the same URL twice dedupes to one (dedupe by `(type, directory, initialUrl)` for URL-bearing opens).
- Closing a browser tab stashes it in `closedTabs`; `reopenLast()` restores it.
- Moving a browser tab to a new group (via split) fires `onMergeDrop` / preserves `browserId`.

**Verification:** New tests pass; manual smoke: `mod+shift+b` opens a tab with an empty webview host; tab survives split + merge.

---

- [ ] **Unit 2: Enable Electron `<webview>` in `claxedo-desktop` + BrowserRegistry + `will-attach-webview` hardening**

**Goal:** Flip `webviewTag: true` behind the flag, install the mandatory `will-attach-webview` allowlist, create a dedicated `persist:agent-browser` session partition, wire a `BrowserRegistry` that tracks `paneId → webContents`, and expose a preload bridge. This is the security-boundary unit — no CDP work yet, just safe embedding.

**Requirements:** R2, R8.

**Dependencies:** Unit 1.

**Files:**
- Modify: `packages/claxedo-desktop/src/main/windows.ts` (guard `webviewTag: true` behind `process.env.CLAXEDO_ENABLE_BROWSER_TAB === "1"` on both BrowserWindow `webPreferences`; unconditionally keep `contextIsolation: true`, `sandbox: false` on the shell window as today, but ensure *guests* get `sandbox: true` via the allowlist below).
- Modify: `packages/claxedo-desktop/src/main/index.ts` (register `app.on("web-contents-created", contents => contents.on("will-attach-webview", allowlistHandler))` at startup).
- Create: `packages/claxedo-desktop/src/main/browser/will-attach-webview.ts` (allowlist handler: delete `preload` / `preloadURL`, set `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`; reject any `webpreferences` string containing `nodeIntegration`, `contextIsolation`, `webSecurity`, `allowRunningInsecureContent`, `experimentalFeatures`; force `partition: "persist:agent-browser"`; validate `src` scheme is http/https).
- Create: `packages/claxedo-desktop/src/main/browser/partition.ts` (one-time `session.fromPartition("persist:agent-browser")` setup: `setPermissionRequestHandler` default-denies `notifications`/`geolocation`/`media`/`midi`/`clipboard-read`/`persistent-storage`/`fullscreen`; `setWindowOpenHandler` default-deny; `will-navigate` allowlist `http`/`https` only; `will-download` denies by default).
- Create: `packages/claxedo-desktop/src/main/browser/registry.ts` (`class BrowserRegistry { register(paneId, wcId): BrowserHandle; unregister(paneId); get(paneId): BrowserHandle }`).
- Create: `packages/claxedo-desktop/src/main/browser/handle.ts` (`class BrowserHandle { constructor(wc); attach(); detach(); … }` — attach/detach is a no-op in this unit; wired in Unit 3).
- Modify: `packages/claxedo-desktop/src/main/ipc.ts` (register `browser:register`, `browser:unregister`, `browser:navigate` handlers via the existing `ipcMain.handle(...)` style).
- Modify: `packages/claxedo-desktop/src/preload/index.ts` (extend existing `contextBridge.exposeInMainWorld("api", api)` — add `browser` namespace inside the existing `api` object; **global is `window.api.browser`, not `window.claxedo.browser`** — verified during deepening).
- Modify: `packages/claxedo-desktop/src/preload/types.ts` (extend existing `ElectronAPI` type with `browser: BrowserBridge`; do NOT create a separate top-level type).
- Modify: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-browser.tsx` — render `<webview src={url()} partition="persist:agent-browser" on:dom-ready={…}/>` when `window.api?.browser` is present; register paneId ↔ webContents on dom-ready; fall back to "requires desktop with CLAXEDO_ENABLE_BROWSER_TAB=1" placeholder.
- Modify: `packages/claxedo-app/index.tsx` (renderer-side gate: expose tab type and command only when `import.meta.env.VITE_CLAXEDO_ENABLE_BROWSER_TAB === "true"`, mirroring the existing `VITE_SANDBOX_ENABLED` gate).
- Test: `packages/claxedo-desktop/src/main/browser/registry.test.ts` (unit tests for register / unregister / get).
- Test: `packages/claxedo-desktop/src/main/browser/will-attach-webview.test.ts` (assert every dangerous attribute is stripped; bad partitions rejected; non-http(s) src rejected).

**Approach:**
- The allowlist handler runs for **every** `will-attach-webview` event across the app, not just agent-browser panes. Guard against accidentally stripping attributes from an unrelated future embedding use case by gating on `event.webPreferences.partition === "persist:agent-browser"` or a marker attribute.
- Registration is triggered from the renderer after the `<webview>` fires `dom-ready`. The renderer passes `(webview as Electron.WebviewTag).getWebContentsId()` to main; main looks up the `webContents` via `webContents.fromId(id)`.
- Navigation flows through `browser:navigate` rather than the webview's `src` attribute so history / error states are fully controlled by the main-process handle.

**Patterns to follow:**
- `packages/desktop-electron/src/main/ipc.ts` existing IPC handler registration style (richer preload surface than claxedo-desktop's; crib freely).
- Terminal portal-host pattern (MEMORY.md: `getTabHostId` + `GroupIdProvider`). Mount the webview DOM node once into a tab-local portal host so splits/focus changes do not recreate it.
- Existing callback+unsubscribe stream pattern (`onSqliteMigrationProgress` in `preload/index.ts:31-49`) is the model for console/node-selected subscriptions.

**Test scenarios:**
- BrowserRegistry.register / get / unregister lifecycle (pure unit).
- `will-attach-webview` handler: drops `preload`, `nodeIntegration*`, `webSecurity`, `allowpopups`; overrides any `webpreferences` string; rejects partition outside allowlist; rejects `file://` or custom-scheme `src`.
- Default-deny permission handler: `session.checkPermission("media", origin)` returns false for any origin.
- Renderer `<webview>` dom-ready → registry has an entry keyed by paneId.
- `browser:navigate` with a bogus URL returns a structured error, does not crash main.
- Flag off (either env var): `webviewTag: false`, `window.api.browser` is undefined, tab renders the "requires desktop" placeholder.

**Verification:** `CLAXEDO_ENABLE_BROWSER_TAB=1 VITE_CLAXEDO_ENABLE_BROWSER_TAB=true` build loads `https://example.com`; cookies from agent-browser tab do NOT appear in host-UI fetches (partition isolation); attempting `<webview nodeintegration>` in the renderer DOM still produces a guest with `nodeIntegration: false`.

---

- [ ] **Unit 3: CDP attach state machine + console stream + screenshot + evaluate**

**Goal:** Attach `wc.debugger` at protocol `"1.3"` with a real state machine (Detached → Attaching → Attached → Reattaching), handle crashes / cross-origin frame-host swaps / DevTools conflicts, buffer console events, and expose screenshot + evaluate as IPC round-trips.

**Requirements:** R4, R5.

**Dependencies:** Unit 2.

**Files:**
- Modify: `packages/claxedo-desktop/src/main/browser/handle.ts` (attach state machine; event subscriptions; `screenshot({ clip? })`, `evaluate(expression)`, `getConsoleLogs({ since?, level?, limit? })`; `Target.setAutoAttach({ flatten: true, waitForDebuggerOnStart: false })` for iframe / worker coverage).
- Create: `packages/claxedo-desktop/src/main/browser/console-buffer.ts` (ring buffer; entry shape `{ id, time, level, args, stack?, source, sessionId? }`; capped at 2,000 per pane; sanitize ANSI / zero-width / unicode-tag chars).
- Create: `packages/claxedo-desktop/src/main/browser/agent-audit-log.ts` (append-only log of agent-initiated tool calls; consumed by the in-chat "agent performed X" entries — the prompt-injection audit trail).
- Modify: `packages/claxedo-desktop/src/main/ipc.ts` (add `browser:getConsoleLogs`, `browser:captureScreenshot`, `browser:evaluate`, subscription channel `browser:onConsoleEntry:<paneId>`, plus `browser:setAgentAllowed(paneId, boolean)` per-tab opt-in toggle).
- Modify: `packages/claxedo-desktop/src/preload/index.ts` (extend `window.api.browser` with callback+unsubscribe stream API for console; promise API for screenshot + evaluate).
- Create: `packages/claxedo-app/src/claxedo-ui/context/browser-pane.tsx` (`createSimpleContext` wrapping `useBrowser(paneId)` with reactive signals for `consoleEntries`, `isLoading`, `currentUrl`, `agentAllowed`, etc.).
- Modify: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-browser.tsx` (subscribe to console stream for a collapsible console drawer under the page; CSS `hidden` toggle per MEMORY.md; per-tab "Allow agent to run JS" toggle UI).
- Test: `packages/claxedo-desktop/src/main/browser/handle.test.ts` (state-machine transitions, event-dispatch, console-buffer eviction, sanitization).

**Approach:**
- **State machine transitions** (see High-Level Technical Design):
  - `dom-ready` → attach + `Target.setAutoAttach({ flatten: true })` + enable `Runtime/Page/Log/Overlay/DOM`.
  - `did-navigate` (main frame only) → re-enable domains on the new RenderFrameHost; resubscribe Target.setAutoAttach.
  - `render-process-gone` → clear subscriptions; schedule reattach on next `dom-ready`.
  - `debugger` `"detach"` event (reason `"canceled by user"` when DevTools opens) → mark Detached; reattempt on `devtools-closed`.
  - `destroyed` → `try { detach() } catch {}`; unregister.
- **Console sources:** subscribe to `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded` on the top session and every flat-attached child session. Normalize into single entry shape; level map: `log|warn|error|debug|info` from console, `error` for exceptions.
- **Screenshot:** `Page.captureScreenshot({ format: "png", captureBeyondViewport: false, clip? })`. Apply the size caps from the Key Decisions table: if resulting data-URL > 1 MB, re-encode to JPEG quality 80; if still > 1 MB, downscale longest side to 1920 px. Return structured `{ error: "no-page" }` for `about:blank`.
- **Evaluate:** `Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true })`; wrap `wasThrown` → structured error. **Refuse the call if the pane is not `agentAllowed`** (per-tab opt-in enforced in main, not just UI).
- **Concurrency:** `getConsoleLogs` is a pull over the ring buffer (not a live subscription share); multiple consumers (renderer drawer + MCP tool polling) never contend on the event stream. `sendCommand` is serialized per session by Electron; parallel `captureScreenshot` + `evaluate` calls are safe.

**Patterns to follow:**
- `on(ready, …)` in effects for subscription setup/teardown (CLAUDE.md pattern).
- CSS `hidden` (not `<Show>`) for the collapsible console drawer (MEMORY.md).

**Test scenarios:**
- Console entry dispatched by guest reaches renderer signal within one tick.
- Ring buffer caps at 2,000; oldest entry drops; ANSI / zero-width chars stripped.
- Screenshot returns a dataURL > 500 bytes for a loaded page; `{ error: "no-page" }` for a brand-new webview at `about:blank`.
- Screenshot > 1 MB PNG → auto-re-encoded to JPEG; still > 1 MB → downscaled.
- `evaluate("1 + 1")` when `agentAllowed = false` → `{ error: { code: "eval-denied" } }`, no CDP call issued.
- `evaluate("1 + 1")` when `agentAllowed = true` → `{ result: 2 }`.
- `debugger.detach` on webview destroy; re-attach after `render-process-gone` + respawn.
- Cross-origin navigation (e.g. `a.com` → `b.com`): domains re-enabled, console keeps flowing.
- DevTools opened on the guest → debugger detaches with reason; re-attach after DevTools closes.

**Verification:** Load `https://example.com`, click "Take screenshot" in the pane UI → image appears in the bound session's prompt composer as an `ImageAttachmentPart`; pane console drawer shows a stream of entries when the page logs; toggle "Allow agent to run JS" off, agent `browser_evaluate_js` call returns a denial with clear error text.

---

- [ ] **Unit 4: Local HTTP listener in Electron main + MCP tool surface `browser_*`**

**Goal:** Stand up a brand-new local HTTP listener inside the Electron main process (bound to `127.0.0.1` on an ephemeral port), mint a per-launch shared secret, pass URL+token to the MCP subprocess at spawn, and register `browser_*` MCP tools that hit this surface with the right auth + CSRF defenses.

**Requirements:** R4, R5 (agent-driven variants).

**Dependencies:** Unit 3.

**Critical correction from deepening:** `packages/claxedo-desktop/src/main/server.ts` is NOT an HTTP server — it spawns the opencode CLI sidecar and health-checks it. This unit introduces net-new infrastructure.

**Files:**
- Create: `packages/claxedo-desktop/src/main/browser/http-bridge.ts` (Hono-on-Node or `node:http` listener bound to `127.0.0.1:<ephemeral>`; routes `GET /browser/tabs`, `POST /browser/:paneId/screenshot`, `GET /browser/:paneId/console`, `POST /browser/:paneId/evaluate`, `POST /browser/:paneId/navigate`, all delegating to `BrowserRegistry` + `BrowserHandle`). Auth middleware rejects any request missing/mis-matching the `x-claxedo-desktop-token` header; rejects any `Origin:` header other than the MCP-synthetic value (or `null`); refuses GETs that mutate state.
- Create: `packages/claxedo-desktop/src/main/browser/token.ts` (`const token = crypto.randomUUID()` at main boot; exposes `getDesktopToken()` and `getDesktopUrl()`).
- Modify: `packages/claxedo-desktop/src/main/index.ts` (start `http-bridge` at app-ready when `CLAXEDO_ENABLE_BROWSER_TAB === "1"`; shut down on `before-quit`).
- Modify: wherever MCP is spawned inside opencode-server / claxedo-server (grep `claxedo-mcp` spawn call sites): inject `CLAXEDO_DESKTOP_URL` + `CLAXEDO_DESKTOP_TOKEN` env from main-process IPC round-trip. If MCP is spawned by opencode-server without knowledge of the desktop, add a new `POST /internal/desktop-handshake` endpoint on the bridge that opencode-server hits on boot to fetch the token before MCP spawn.
- Modify: `packages/claxedo-server/src/claxedo-mcp/server.ts` (register `browser_list_tabs`, `browser_screenshot`, `browser_get_console_logs`, `browser_evaluate_js`, `browser_navigate`; each calls the desktop HTTP bridge via `desktopRequest(path, init)`).
- Create: `packages/claxedo-server/src/claxedo-mcp/browser-tools.ts` (tool definitions + zod schemas, imported by `server.ts`).
- Create: `packages/claxedo-server/src/claxedo-mcp/desktop-request.ts` (reads `CLAXEDO_DESKTOP_URL` + `CLAXEDO_DESKTOP_TOKEN` env; sets `x-claxedo-desktop-token` header; sets custom `Origin:` header; returns structured error `"Browser tabs require the desktop app."` when env is absent).
- Test: `packages/claxedo-desktop/src/main/browser/http-bridge.test.ts` (auth + CSRF: missing token rejected; bad `Origin:` rejected; GET mutating state rejected; `127.0.0.1` bind verified).
- Test: `packages/claxedo-server/src/claxedo-mcp/browser-tools.test.ts` (unit-test each tool's zod schema + response shape against a fake bridge).

**Approach:**
- Tool naming mirrors superset-terminal-ref / existing MCP conventions: `browser_screenshot`, `browser_get_console_logs`, etc.
- `browser_list_tabs` is how the agent discovers paneIds — returns `[{ paneId, title, currentUrl, groupId, agentAllowed }]`. `agentAllowed` flag lets the agent tell the user "I need you to flip this on" when a write-side tool is denied.
- Each tool takes `pane_id` as the first input and returns the MCP `{ content: [...] }` shape. Screenshots return `[{ type: "image", mimeType: "image/png", data: base64 }]` inline.
- Agent-initiated `browser_screenshot` / `browser_evaluate_js` / `browser_navigate` calls write to `agent-audit-log.ts` (Unit 3) — the bound session receives an "agent performed X on tab Y" system message rendered alongside the result. This is the prompt-injection audit trail.
- Per-image size caps apply server-side too: MCP tool refuses to return an image > 1 MB to a single tool-call response (re-encodes / rejects).

**Patterns to follow:**
- `council` tool at `claxedo-mcp/server.ts:320-358` is the reference shape.
- `httpRequest` helper at `claxedo-mcp/server.ts:32-55` is the template for `desktopRequest`.

**Test scenarios:**
- Each tool returns a well-formed MCP response; validation errors produce `{ isError: true }`.
- `browser_list_tabs` with no browser tabs open returns an empty array, not an error.
- `browser_screenshot` on a destroyed pane returns `{ isError: true, content: [{ text: "Pane <id> not found." }] }`.
- `browser_evaluate_js` on a pane with `agentAllowed = false` returns `{ isError: true }` with a message explaining the toggle.
- Non-desktop environments (CLAXEDO_DESKTOP_URL absent) return a user-legible `{ isError: true }` for every tool.
- CSRF test: a simulated browser `fetch` from any Origin other than the MCP-synthetic value is rejected 403.
- Token test: a request missing or mis-matching `x-claxedo-desktop-token` is rejected 401.

**Verification:** Running the desktop app with a loaded browser tab, an agent-issued `browser_screenshot` tool call returns a usable PNG that matches what the pane's own screenshot button produces; the chat transcript shows an "agent captured screenshot of tab X" entry; `curl` against the bridge URL without the token fails.

---

- [ ] **Unit 5: Element picker + selector generator (guest-side IIFE via @medv/finder)**

**Goal:** Click-to-select a DOM element on the page via CDP overlay; emit a stable CSS selector (generated in the guest by `@medv/finder`) + bounding box + element-only screenshot back to the renderer.

**Requirements:** R6.

**Dependencies:** Unit 3.

**Files:**
- Modify: `packages/claxedo-desktop/src/main/browser/handle.ts` (methods `setInspectMode(enabled)`, event `onNodeSelected`; on `Overlay.inspectNodeRequested`, route by `sessionId` to the right frame's `DOM.describeNode`, dispatch guest IIFE via `Runtime.evaluate`, fetch `DOM.getBoxModel`, crop screenshot).
- Create: `packages/claxedo-desktop/src/main/browser/selector-generator.guest.ts` (string asset — a self-contained IIFE that loads `@medv/finder`'s minified bundle inline, exposes `__generateSelector(backendNodeId)`; preference ladder: `data-testid`/`data-test`/`data-cy` → stable `id` → semantic attribute combo (`role`, `name`, `aria-label`, `href`) → tag+class (with rejecter for `css-*`, `sc-*`, `jsx-*`, `_module_*` CSS-in-JS prefixes) → `:nth-of-type` chain; shadow-DOM: emit composite `{ host, shadow }` path when the node is inside an open shadow root).
- Create: `packages/claxedo-desktop/src/main/browser/selector.ts` (main-process wrapper: serializes the guest IIFE into `Runtime.evaluate({ expression, returnByValue: true })`, parses response, falls back to `DOM.describeNode` + `:nth-of-type` chains if the IIFE can't guarantee uniqueness).
- Modify: `packages/claxedo-desktop/src/main/ipc.ts` (`browser:setInspectMode`, subscription `browser:onNodeSelected:<paneId>`).
- Modify: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-browser.tsx` (add "Inspect" toggle button in the address bar; subscribe to node-selected events; suppress user interaction when inspect mode is on).
- Test: `packages/claxedo-desktop/src/main/browser/selector.test.ts` (selector uniqueness + preference-order tests against fixture DOMs in happy-dom; shadow-DOM composite path test; CSS-in-JS prefix rejecter test).
- Add dependency: `@medv/finder` (pin to ^4.x) in `packages/claxedo-desktop/package.json`. Bundle the minified source into `selector-generator.guest.ts` at build time via Vite's `?raw` import so the main-process bundle carries exactly one copy of the code.

**Approach:**
- **Guest-side selector computation** is correct (main process doesn't have a DOM). The `.guest.ts` naming convention makes the boundary explicit: pure browser code, no Node imports, bundled as a string.
- Overlay color config uses the project's accent color.
- **Iframe / cross-origin handling:** `Target.setAutoAttach({ flatten: true })` (from Unit 3) gives us a session per frame. Inspect mode is enabled on the top session; `inspectNodeRequested` arrives on whichever session the clicked node lives in — we route by `sessionId`, resolve `backendNodeId` in that session, and include the frame URL in the result so the comment carries "element in iframe X at origin Y".
- **Shadow DOM:** open shadow roots traversed via `DOM.getDocument({ pierce: true })`; `@medv/finder` run with a custom traversal hook that follows `shadowRoot` when present. Closed shadow roots are unsupported for v1 — emit a clear error rather than a wrong selector.
- Element screenshot = `Page.captureScreenshot({ clip: borderBox + 16px padding, format: "png" })`. Apply the Unit 3 size caps. If border box > 1920×1080, cap and scale.
- Native Chromium overlay already dims the rest of the page and highlights on hover; we don't need a custom DOM overlay.

**Patterns to follow:**
- `@medv/finder` README (https://github.com/antonmedv/finder) for the rejecter/predicate configuration shape.

**Test scenarios:**
- Inspect mode enable → hover highlights; click fires exactly once; auto-disables.
- Selector generation returns unique selectors for: element with `data-testid`, element with id, generic `<div>` with sibling duplicates (falls back to `:nth-of-type` chain).
- CSS-in-JS class `css-a1b2c3` is rejected by the rejecter; falls through to tag+role combo.
- Element with no stable attributes still returns a selector that resolves to exactly that node (verified via round-trip `Runtime.evaluate("document.querySelector(<s>) === <node>")`).
- Element inside an open shadow root → returns composite `{ host: "my-widget", shadow: "button.primary" }`.
- Element inside a closed shadow root → returns `{ error: "shadow-root-closed" }`.
- Element inside a same-origin iframe → returns selector + frame URL in the payload.
- Cross-origin iframe: picker routes via the child session; selector scoped to that frame.

**Verification:** Manual: open any page, click inspect, click a button, see its selector + cropped screenshot in the pane UI. Click an element inside an iframe — selector + frame URL appear. Click into an open shadow root — composite path appears.

---

- [ ] **Unit 6: Element-comment composer + `ContextItem` widening + new `page-comment:*` capability**

**Goal:** Let the user type a comment on a selected element, store it, and flow it through `pane-bus` to the bound session via a NEW capability pair (`page-comment:produce` / `page-comment:receive`), where submit produces a text part + image part with the right metadata.

**Requirements:** R6, R7.

**Dependencies:** Unit 5.

**Critical corrections from deepening:**
1. `packages/claxedo-app/src/overrides/context/prompt.tsx` already exists (293 lines) and owns `ContextItem`. Unit **edits** it in place; does not create it.
2. No override of `packages/app/src/utils/comment-note.ts`. Formatting happens at the producer. Fewer upstream-sync risks, no chance of silently changing review behavior.
3. New capability pair `page-comment:produce` / `page-comment:receive`, NOT overloading `comment:*`. Preserves pane-bus opt-in semantics and keeps review consumers untouched.

**Files:**
- Create: `packages/claxedo-app/src/claxedo-ui/components/browser/element-comment-composer.tsx` (wraps `LineCommentEditor` from `packages/ui/src/components/line-comment.tsx`; renders a selector chip + screenshot thumbnail; on submit calls `onElementComment`).
- Create: `packages/claxedo-app/src/claxedo-ui/components/browser/element-selection-chip.tsx` (the `<selection>` JSX for the editor — shows selector, truncated, with a copy button).
- Create: `packages/claxedo-app/src/claxedo-ui/utils/format-element-comment-note.ts` (claxedo-app-local helper: `"The user commented on element \`{selector}\` at {pageUrl}: {comment}"`; appends truncated outerHTML as a fenced block if < 1 KB).
- **Modify** (not create): `packages/claxedo-app/src/overrides/context/prompt.tsx` (widen `ContextItem` to `FileContextItem | ElementContextItem`; add `contextItemKey` branch for `"page-element"` keyed by `(pageUrl, selector, commentID)`). Update the existing `packages/claxedo-app/src/overrides/context/prompt.vitest.tsx` with the new variant's shape + key function.
- Create: `packages/claxedo-app/src/overrides/components/prompt-input/build-request-parts.ts` (override dispatches on `item.type === "page-element"` to emit text + image parts, otherwise delegates to upstream's `buildRequestParts`).
- Modify: `packages/claxedo-app/src/claxedo-ui/context/pane-bus.ts` (add `"page-comment:produce"` / `"page-comment:receive"` to the `PaneCapability` union; add `ElementCommentPayload` type; add `sendElementComment(fromLeafId, payload)` wrapping the existing dispatcher; `CommentPayload` remains the file-only shape it is today — NOT widened).
- Create: `packages/claxedo-app/src/claxedo-ui/context/browser-comments.tsx` (`useBrowserComments()` context: `list(tabId)`, `add`, `remove`, `update`; persisted via `Persist.global("browser.comments.v1", [legacy keys])`).
- Modify: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-browser.tsx` (`handleElementComment(payload)` mirrors `handleLineComment`: computes final note string via `formatElementCommentNote`, calls `browserComments.add`, pushes `ElementContextItem` into `prompt.context.add`, watcher effect forwards new items of `type === "page-element"` via `sendElementComment`; `usePane({ capabilities: ["page-comment:produce"], ... })` + `autoBind(leafId, "comment", "page-comment:receive")`).
- Modify: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/generic-leaf-node.tsx` (`SessionPaneBusConsumer` additionally registers `"page-comment:receive"` with a handler that calls `prompt.context.add(elementPayload)`; file-only `comment:receive` handler unchanged).
- Create: `packages/claxedo-app/src/overrides/context/prompt.upstream-shape.test.ts` (characterization test: pins the override's `FileContextItem` shape against upstream's exported type; fails with a clear error on any upstream rename — the upstream-sync mitigation from the decisions table).
- Test: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-browser.test.ts` (integration: element-comment → pane-bus → prompt.context → buildRequestParts output shape).

**Approach:**
- `handleElementComment(payload)` steps: (1) compute `noteText` via `formatElementCommentNote(payload)` — stored on the payload so `comment-note.ts` upstream is never touched; (2) `browserComments.add({...})`; (3) `prompt.context.add({ type: "page-element", pageUrl, selector, boundingBox, outerHTML?, screenshotDataUrl?, comment, noteText, commentID: saved.id, commentOrigin: "browser" })`.
- `build-request-parts` override emits: synthetic text part (`text = item.noteText`, `metadata.opencodeComment = { origin: "browser", selector, boundingBox, pageUrl, outerHTML? }`) + image part (`{ mime: "image/png", url: screenshotDataUrl, filename: "element-<short(selector-hash)>.png" }`) + any @-mentioned file parts parsed from the comment body. Unchanged items (file comments) pass straight through to upstream.
- Pane-bus `page-comment:*` capability is independent of `comment:*`. Session consumers register for both; review consumers see only `comment:*`; future third variants get their own capability.

**Patterns to follow:**
- `review-workspace.tsx:635-661` (`handleLineComment`) is the template for the producer-side handler.
- `pane-bus.ts:286-325` (`sendComment`) — mirror for `sendElementComment`.
- `overrides/pages/session.tsx` / existing `overrides/context/prompt.tsx` show the `@/` override shape.

**Test scenarios:**
- Submit element comment → `prompt.context.items` has one item `{ type: "page-element", … }` with `noteText` already populated.
- Bound session pane's `prompt.context.items` receives the item (pane-bus round-trip via `page-comment:receive`).
- Session pane with ONLY `comment:receive` capability (hypothetical review-only consumer) does NOT receive the element payload.
- `buildRequestParts` over a payload with one page-element item emits exactly: 1 text part (synthetic, with metadata) + 1 image part. No trailing empty parts.
- `buildRequestParts` over a payload with file + page-element items produces them in the expected order; file part serialization is identical to upstream.
- Removing a comment on the producer side fires a `sendCommentRemoval`-equivalent and the consumer's context drops it.
- Characterization test on upstream shape: renaming `FileContextItem.path` upstream → override test fails loudly with a diff.

**Verification:** Full manual flow: open browser tab, load page, open a session pane alongside it, inspect an element, comment, type a short message in the session, send → the chat shows the image + note; the LLM can read the selector via the structured metadata; a review-only consumer pane does not see stray browser comments.

---

- [ ] **Unit 7: Persistence, history, closed-tabs, feature-flag rollout**

**Goal:** Remember where each browser tab was, which tabs are closed, and keep this gated behind the flag.

**Requirements:** R8.

**Dependencies:** Units 1, 6.

**Files:**
- Modify: `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/types.ts` (`BrowserTabState` extension on `TabItem` persisted).
- Create: `packages/claxedo-app/src/claxedo-ui/context/browser-history.tsx` (`useBrowserHistory()`: per-tab back/forward + global recent URLs, `Persist.global("browser.history", …)`).
- Modify: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-browser.tsx` (address-bar autocomplete from recent URLs).
- Modify: `packages/claxedo-app/CLAUDE.md` or `packages/claxedo-app/.dev-docs/browser-tab.md` (new): feature-flag instructions; note webview enablement is per-flag.
- Modify: `MEMORY.md`-style user memory note (auto-memory update via feedback file rather than editing the global memory).

**Approach:**
- Persist global recent-URL list (top 50) and per-tab forward/back history (max 50 per tab) using the existing `Persist.global` with legacy-key fallback.
- Reopening a closed browser tab restores `currentUrl` + forward/back history; does not restore in-page scroll or form state (webview is recreated; the browser tab is not a checkpoint of the page).
- Feature flag is read at module-load time in both the preload bridge and the renderer; hot-toggle is not supported.

**Test scenarios:**
- Close + reopen recovers URL and title.
- Autocomplete shows recent URLs with fuzzy match.
- Flag off: `addBrowserTab` fails with a toast "Browser tabs require the desktop app with CLAXEDO_ENABLE_BROWSER_TAB=1"; no tab is created.

**Verification:** Toggle flag on → open tabs → restart app → tabs and history survive (exception: the webview's in-page state does not, which is documented).

---

- [ ] **Unit 8: Cross-cutting test coverage + CI smoke**

**Goal:** Lock in the feature with tests at every seam that matter.

**Requirements:** all.

**Dependencies:** Units 1–7.

**Files:**
- Modify: `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout.test.ts` (browser tab tab-actions round-trip).
- Create: `packages/claxedo-app/src/claxedo-ui/context/pane-bus-browser.test.ts` (pane-bus element-comment contract).
- Create: `packages/claxedo-desktop/src/main/browser/integration.test.ts` (end-to-end with a headless `BrowserWindow` loading `about:blank` / a local fixture — attach, screenshot, evaluate, overlay).
- Create: `packages/claxedo-server/src/claxedo-mcp/browser-tools.test.ts` (unit-test tool zod schemas + error shapes against a fake desktop HTTP).
- Create: `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-browser.test.ts` (integration-style: inspect → comment → submit → request parts shape; uses a stubbed `window.claxedo.browser`).

**Approach:**
- Reuse the existing `bun run test` + `--conditions=browser` setup (MEMORY.md warning). Electron main-process tests use `vitest` + a minimal `BrowserWindow` harness; skip on CI runners without X server by gating on `process.platform !== "linux" || process.env.CI_ELECTRON === "1"`.
- Contract tests for MCP tools use captured JSON payloads (fixtures in `__fixtures__/browser/`) so the same payloads double as MCP developer-docs examples.

**Execution note:** Tests were designed in Unit 1–7; this unit is about running the full suite, closing gaps, and validating the Phase 1 exit criteria.

**Verification:** CI passes; manual smoke checklist (below) all green.

## System-Wide Impact

- **Interaction graph:**
  - New pane-bus capability pair `page-comment:produce` / `page-comment:receive`. Session consumers register for both `comment:receive` AND `page-comment:receive`.
  - New caller of `usePane`, `autoBind`, `sendElementComment` (parallel to `sendComment`).
  - New consumer of `prompt.context.add` with a new `"page-element"` discriminant, via widened `ContextItem` in the existing `overrides/context/prompt.tsx`.
  - `generic-leaf-node.tsx` dispatcher gets one more Match arm (`"browser"`), and its `SessionPaneBusConsumer` gains one more capability registration.
  - Electron main gains a long-lived `debugger` session per browser pane + a new local HTTP listener on `127.0.0.1:<ephemeral>`.

- **Security / trust boundaries (new, and most consequential):**
  - The new HTTP listener is a fresh attack surface. Every local process on the machine can reach `127.0.0.1`; only the per-launch token + custom-header + Origin allowlist keep them out. This is the weakest link in the feature's threat model — see Risks.
  - `<webview>` embedding of arbitrary third-party URLs extends the host's attack surface to the embedded content's origin. The `will-attach-webview` allowlist + `persist:agent-browser` partition + permission default-deny collectively reduce but do not eliminate the surface.
  - Prompt-injection from page content reaches the LLM via three channels (console logs, screenshot pixels, element `outerHTML`). Every channel is tagged so the model treats it as untrusted data, and every agent-initiated tool call writes to an in-chat audit entry — this pairing is non-negotiable.
  - Session/cookie isolation: the dedicated `persist:agent-browser` partition means logins inside agent-browser tabs do NOT carry to the host UI or the user's real browser. This is a *feature* for security and a UX surprise for users — must be documented prominently.

- **Error propagation:**
  - CDP errors bubble as `{ error: { code, message } }` from main → renderer → bound session (never thrown across the preload bridge).
  - Webview crash (`render-process-gone`) emits `browser:crashed` → renderer shows error card with retry; debugger state machine transitions to Reattaching.
  - Cross-origin main-frame navigation triggers domain re-enable; in-flight MCP commands bound to the pre-nav session get a structured `{ error: "session-swapped" }`.
  - Local HTTP bridge returns `401` (bad token), `403` (bad Origin), `404` (unknown paneId), `409` (pane not agentAllowed for write tools), `413` (payload > caps), `5xx` (internal).

- **State lifecycle risks:**
  - Detaching `webContents.debugger` on webview destruction MUST happen before garbage collection; otherwise the Chromium process leaks event-listener chains. Tie to `wc.on("destroyed", …)` + `app.on("before-quit", …)` fallback + `try/catch` on `detach()` (historic Electron race, see PR #24344).
  - `Target.setAutoAttach` flat-session children do not auto-detach on main-frame navigation; must explicitly re-subscribe.
  - Persist store writes are batched; fast tab churn (open/close quickly) must not produce duplicate persist keys.
  - Per-launch token lives only in process memory; any `claxedo-desktop` crash invalidates all in-flight MCP tool calls. MCP must tolerate `401` by re-reading env on next call (trivial if env is reset at MCP relaunch; harder if MCP outlives desktop — flag in Unit 4).

- **Concurrency:**
  - `webContents.debugger.sendCommand` is serialized per session. Parallel tool calls (screenshot + evaluate) are safe at the CDP layer.
  - Console events fan out to multiple consumers (renderer drawer + MCP polling). `getConsoleLogs` is pull-based over the ring buffer; consumers never contend on the event stream itself.
  - Two concurrent MCP clients (e.g. Claude + Codex) can both hit the same pane. The audit log attributes the caller; per-tab `agentAllowed` is a single boolean, not per-client.

- **API surface parity:**
  - `browser_*` MCP tools return MCP-standard shapes so third-party MCP clients (Claude, Codex, Gemini) all consume them.
  - Preload bridge shape is versioned via preload `types.ts` (extending the existing `ElectronAPI` at `/packages/claxedo-desktop/src/preload/types.ts`); bumping it without updating consumers is caught by TS.
  - Callback-with-unsubscribe stream contract matches existing bridge conventions (`onSqliteMigrationProgress`, `onMenuCommand`). Not a new idiom.

- **Integration coverage:**
  - Unit tests alone won't catch the real CDP failure modes (version drift, session-attach races, overlay teardown leaks, DevTools-conflict detach). Integration tests in Unit 8 run against a real `BrowserWindow`.
  - Pane-bus autoBind has a known edge case (two sibling session panes → no autoBind, kebab picker required). Element-comment flow inherits this and must be tested against the same edge case. New capability `page-comment:*` inherits the same kebab UX.
  - CSRF-from-localhost test requires a simulated browser `fetch` with a foreign Origin header — critical to add.

- **Cross-origin / shadow-DOM surfaces (new):**
  - Cross-origin iframes: pickable but per-session; selectors scoped to the iframe's frame URL; screenshots of iframe regions are captured at the top-level viewport.
  - Open shadow roots: traversed with `DOM.getDocument({ pierce: true })`; selectors emitted as composite `{ host, shadow }`.
  - Closed shadow roots: unsupported; picker returns `{ error: "shadow-root-closed" }`.

## Risks & Dependencies

### Top threats (ranked)

1. **Prompt-injection via page content.** Hostile text rendered in the DOM, console output, or visible pixels reaches the LLM through console logs / screenshots / element comments, which the LLM treats as authoritative instructions. A single unvetted page (an ad, a GitHub comment, a crafted README) can weaponize the agent against the user's own tools. **Mitigations (all required for v1):** tag every page-derived string with a structural "untrusted data" marker in metadata; truncate `outerHTML` aggressively; sanitize console entries for zero-width/ANSI/unicode-tag characters; require per-tool-call user confirmation for first-time agent-initiated `browser_evaluate_js` / `browser_navigate` on a tab; render an in-chat "agent performed X on tab Y" audit entry for every agent-initiated call (the single highest-leverage control).
2. **Arbitrary JS on logged-in tabs via `browser_evaluate_js`.** Runs in the origin of whatever page is loaded. Equivalent to a malicious browser extension: read/send email, move money, exfiltrate non-HttpOnly cookies. **Mitigations (all required for v1):** per-tab `agentAllowed` toggle off by default; workspace-settings origin allowlist (default: `localhost`, `127.0.0.1`, user-configured dev-preview origins); tool denies on non-allowlisted origins with a legible error. No exceptions. Write-side tools (`browser_click`, `browser_type_text`, `browser_navigate`) gated by the same toggle — these remain NOT-v1 per Scope Boundaries, but when they ship they inherit the gate.
3. **Screenshot-based exfiltration of credentials / MFA / PII.** `Page.captureScreenshot` captures whatever pixels the user can see (password-manager overlays, 2FA codes, DMs, bank balances) and ships base64 to the model provider. **Mitigations (required for v1):** agent-initiated screenshots render a visible in-chat "agent captured screenshot of tab X" entry with a thumbnail preview; user can revoke retroactively (removes from context, not from provider logs — documented limitation); per-tab screenshot rate limit (1/sec) prevents a compromised agent from streaming the screen.
4. **Local HTTP bridge abuse.** The new `127.0.0.1:<ephemeral>` listener is reachable by any process on the machine and (via CSRF) by any webpage the user visits in their real browser. **Mitigations (required for v1):** bind `127.0.0.1` only (NOT `0.0.0.0`); per-launch UUID token in `x-claxedo-desktop-token` custom header (browsers cannot set custom headers cross-origin without CORS preflight, which we never grant); Origin-header allowlist rejects everything but the MCP-synthetic origin; GETs never mutate state; no cookie-based auth. Verified by a CSRF test in Unit 4.
5. **Webpreferences / preload injection in `<webview>`.** Historic footgun (CVE-2018-1000136, CVE-2020-4077): the embedder's HTML could set `nodeintegration` or `preload` on the guest unless main-process strips them. **Mitigations (required for v1):** `will-attach-webview` allowlist (Unit 2) deletes `preload`, forces `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `contextIsolation: true`, `sandbox: true`; rejects any `webpreferences` string that enables dangerous flags; pins partition to `persist:agent-browser`.
6. **Cookie / storage bleed across agent-browser tabs.** All agent-browser tabs share `persist:agent-browser`. Tab A (hostile) and Tab B (user's logged-in site) in the same partition share cookies, localStorage, serviceWorkers. **Mitigation (v1 accepts with documented limit):** one-partition-per-browser-tab isolation is explicitly deferred (Scope Boundaries). The partition is at least separated from the host UI's session and the user's real browser. Fully-isolated per-tab partitions are a follow-up.

### Operational / delivery risks

- **Electron CDP protocol drift.** The protocol revision in Electron's bundled Chromium changes between major Electron releases; methods like `Overlay.setInspectMode`, `Page.captureScreenshot` with `captureBeyondViewport`, `Target.setAutoAttach` with `flatten` must be verified against the exact Electron version (`claxedo-desktop` ships Electron 40.4.1 at time of writing). **Mitigation:** pin `protocolVersion` at attach; feature-probe via `Schema.getDomains` on first attach; log-and-degrade if a required domain is missing.
- **Debugger lifecycle edge cases.** `render-process-gone` does NOT auto-reattach the debugger; cross-origin main-frame navigation invalidates per-target sessions; opening DevTools force-detaches with a `"canceled by user"` reason. All three handled explicitly by the Unit 3 state machine — but each is an integration-test-only failure mode (won't show up in unit tests).
- **`<webview>` deprecation path.** Electron's official docs currently say "we recommend to not use the `webview` tag." It still works in Electron 40 and is not formally deprecated, but Chromium architectural changes could land at any time. **Mitigation:** schedule an Electron-version review each major bump; documented migration target is `WebContentsView` with `ResizeObserver`-driven bounds syncing; flag-off kill-switch keeps the feature toggleable in production.
- **`registerTabType` global-state antipattern.** Repo RFC flags this registry as something to move away from. Browser tab becomes the first real caller, entrenching it. **Mitigation:** documented as an Open Question; acceptable short-term debt if the RFC's successor pattern hasn't landed.
- **MCP tool surface without a bound session.** If an agent calls `browser_screenshot` for a tab that isn't bound to a session, where does the image go? **Mitigation:** `browser_screenshot` returns the image to the agent directly (MCP inline image content). A separate, explicit `browser_attach_to_session(tab_id, session_id)` tool can attach if the agent wants the image to also enter the chat.
- **Selector stability across navigations.** Selectors resolved in one page load are meaningless after SPA route transitions. **Mitigation:** record `pageUrl` + selector together; re-verify on read; if stale, show "element no longer present" in the rendered comment.
- **Data-URL screenshot size.** Base64 is +33% vs binary; 1440p PNG = 3–5 MB base64 → significant fraction of provider context. **Mitigation:** 1 MB per-image cap (re-encode to JPEG if over; downscale longest side to 1920 px if still over); 4-image per-message cap; provider 4xx turned into legible in-UI error.
- **Payload redaction in debug logs.** Any logs containing `ImageAttachmentPart` will contain full base64 screenshots → log-rotation keeps them. **Mitigation:** explicitly redact image parts in any debug-logging path.
- **New-tab shortcut conflict.** `mod+shift+b` — verification showed no conflict in `use-session-commands.tsx`, but additional grep across `packages/claxedo-app/src/claxedo-ui/` is required before commit. `useCommand().register(...)` handles collision detection and user overrides.

### V1 must-ship-before-flag-on checklist

Non-negotiable before `CLAXEDO_ENABLE_BROWSER_TAB=1 VITE_CLAXEDO_ENABLE_BROWSER_TAB=true` is enabled for anyone beyond the implementer:

1. Dedicated `persist:agent-browser` partition enforced in `will-attach-webview`.
2. Strict `will-attach-webview` handler stripping all dangerous attributes (Unit 2).
3. `browser_evaluate_js` behind per-tab `agentAllowed` + origin allowlist.
4. Local HTTP routes bound to `127.0.0.1`, per-launch token in custom header, Origin allowlist, no cookie auth. Verified by Unit 4 CSRF test.
5. `setWindowOpenHandler` default-deny + `will-navigate` http(s) allowlist on `persist:agent-browser`.
6. In-chat audit entry for every agent-initiated `browser_screenshot` / `browser_evaluate_js` / `browser_navigate`.

### Safe to defer

- Per-tab isolated partitions (beyond the single `persist:agent-browser`).
- Download handling policy beyond "deny by default."
- ServiceWorker scope auditing within the dedicated partition.
- Idle-detach ("detach debugger on hide > 5min"); operational tuning item.
- Iframes-inside-the-page nested picker improvements.
- Fine-grained clipboard-read permission policy (default-deny suffices for v1).
- Full host-renderer CSP pass (standard `default-src 'self'` + known asset origins is enough for flag-on).

## Alternative Approaches Considered

- **`WebContentsView` instead of `<webview>`** — the officially-recommended path in Electron 30+ (`BrowserView` is deprecated). Rejected for v1 because `WebContentsView` requires main-process RPC on every layout tick to sync manual bounds; split-drag UX on a live page would degrade. Re-evaluate each Electron major bump; migration documented (use `ResizeObserver` on the host DOM element to drive bounds).
- **`BrowserView` instead of `<webview>` tag** — deprecated since Electron 30. Would fight the DOM layout. Rejected outright.
- **Iframe-based cloud/web browser tab** — rejected for v1 because third-party pages block `X-Frame-Options`; mitigations (gateway CSP rewrite, service-worker header stripping) compound rapidly; console + screenshot in cross-origin iframes is fundamentally constrained. Parked as a follow-up for the cloud build.
- **Puppeteer (or Playwright) as the CDP client** — rejected because Electron ships its own `webContents.debugger` CDP client; the extra dependency buys us nothing except a heavier install.
- **In-renderer element picker (inject `overlay.js` script on every page load)** — rejected because it requires origin cooperation or a gateway HTML-rewriting proxy. The CDP `Overlay.setInspectMode` does the same thing from the browser host, no injection required, works on any origin.
- **Parallel `useBrowserComments` context that never enters `prompt.context`** — rejected because it would split the submit path and force parallel serialization code in `buildRequestParts`. The narrower change is to widen `ContextItem`. Trade-off acknowledged: upstream-sync fragility, mitigated by a characterization test (Unit 6).
- **Overloading `CommentPayload` as a discriminated union** — initially chosen, reconsidered during deepening. Rejected in favor of a new `page-comment:*` capability pair. Overloading `comment:*` would silently broadcast page-element variants to any future `comment:receive` consumer, eroding pane-bus's opt-in contract.
- **Overriding `packages/app/src/utils/comment-note.ts`** — initially chosen, reconsidered during deepening. Rejected because it changes dispatch shape for review callers too; regressions there wouldn't show up in browser tests. Instead, formatting happens at the browser-pane producer and the computed note string rides on the payload.
- **Extending `claxedo-desktop/src/main/server.ts` as the MCP HTTP bridge** — initially chosen, rejected during deepening once verification showed `server.ts` is a sidecar-CLI spawner, not an HTTP server. Replaced with a net-new `node:http` / Hono-on-Node listener (Unit 4).
- **Reusing an existing desktop↔gateway shared secret for MCP auth** — initially chosen, rejected during deepening once verification showed no such secret exists. Replaced with a per-launch UUID minted at main-process boot and passed to MCP via env.
- **Per-browser-tab git worktree creation in v1** — rejected after user clarified the original "new worktree" phrasing was loose. Not on critical path; can land later behind a different flag if the UX demand materializes.
- **Hand-rolled CSS selector generator** — initially planned, replaced with `@medv/finder` during deepening. Library is ~1.5 KB, actively maintained in 2026, configurable rejecter/predicate ladder. Reinventing selector generation is unnecessary toil with known footguns.

## Phased Delivery

### Phase 1 — Foundation (ships behind flag)

Units 1–3. Exit criteria:
- Cmd+Shift+B (or chosen chord) opens a browser tab.
- Tab loads any URL via address bar.
- Pane UI shows a live console drawer + "Take screenshot" button that drops an image into the bound session's composer.

### Phase 2 — Agent surface

Unit 4. Exit criteria:
- `browser_list_tabs`, `browser_screenshot`, `browser_get_console_logs`, `browser_evaluate_js`, `browser_navigate` callable from Claude / Codex MCP clients; all returning well-formed MCP responses against a live desktop.

### Phase 3 — Element commenting

Units 5–6. Exit criteria:
- Inspect mode picks an element; composer attaches a comment + screenshot; bound session receives the item; submit sends both a natural-language note and the image to the LLM; the LLM can read the selector metadata.

### Phase 4 — Polish + rollout

Units 7–8. Exit criteria:
- Persistence + closed-tabs + history work across restart.
- Full test suite passes.
- Documentation updated.
- Flag-off state is indistinguishable from today's behavior.

## Documentation / Operational Notes

- Update `MEMORY.md` (via auto-memory) with a new section "Agentic Browser Tab" summarizing the flag, the CDP contract, and the selector-generator guarantees. This is exactly the kind of institutional learning the learnings-researcher agent identified as a gap.
- Update `packages/claxedo-app/.dev-docs/` with a page-long "How the browser tab works" dev-doc.
- Register new hotkeys in whatever key-table the rest of the app maintains (grep `mod+shift` to find it).
- Feature-flag documentation lives in `packages/claxedo-desktop/README.md` under Environment Variables.
- Release note copy: "Open a live web page alongside your chat. Inspect any element and tell the agent about it."

## Operational / Rollout Notes

- Gate behind `CLAXEDO_ENABLE_BROWSER_TAB=1` for at least one weekly release after Phase 3 ships.
- No server-side changes required for rollback (MCP tools will no-op cleanly if the desktop endpoint is unreachable; returning a legible error).
- Monitor the Electron main process memory for attached browser tabs; each attached `debugger` session holds references to event listeners. If memory regresses, add a "detach on hide > 5min" policy.

## Sources & References

- **Primary (opencode)**:
  - `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/` (types, tab-actions, groups, split, registry)
  - `packages/claxedo-app/src/claxedo-ui/components/multi-pane/` (multi-pane-tab, generic-leaf-node, session-pane-bus-consumer)
  - `packages/claxedo-app/src/claxedo-ui/components/review-workspace.tsx` (comment precedent, lines 202–1027)
  - `packages/claxedo-app/src/claxedo-ui/context/pane-bus.ts` (comment routing)
  - `packages/app/src/context/prompt.tsx` (ContextItem), `packages/app/src/utils/comment-note.ts`, `packages/app/src/components/prompt-input/build-request-parts.ts` (chat serialization — overridden via `@/`)
  - `packages/ui/src/components/line-comment.tsx` + `line-comment-annotations.tsx` + `session-review.tsx` (composer UI primitives reused)
  - `packages/claxedo-desktop/src/main/windows.ts` + `ipc.ts` + `server.ts` + `preload/` (Electron host to extend)
  - `packages/claxedo-server/src/claxedo-mcp/server.ts` (MCP tool registration)
  - `packages/opencode/src/server/routes/instance/experimental.ts` (worktree + agent tool routes; not extended here, kept for reference)
- **Prior art (external repo)**:
  - `~/test/superset-terminal-ref/apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/BrowserPane/` (BrowserPane component family)
  - `~/test/superset-terminal-ref/apps/desktop/src/main/lib/browser/browser-manager.ts` (main-process BrowserManager singleton)
  - `~/test/superset-terminal-ref/apps/desktop/src/lib/trpc/routers/browser/browser.ts` (TRPC browser router surface)
  - `~/test/superset-terminal-ref/packages/desktop-mcp/src/mcp/tools/` (MCP tool definitions — naming & schema reference)
- **External docs**:
  - Electron `<webview>` (with current "not recommended" banner) — https://www.electronjs.org/docs/latest/api/webview-tag
  - Electron migration guide to `WebContentsView` — https://www.electronjs.org/blog/migrate-to-webcontentsview
  - Electron `webContents.debugger` — https://www.electronjs.org/docs/latest/api/debugger
  - Electron `webContents` (`render-process-gone` event) — https://www.electronjs.org/docs/latest/api/web-contents
  - Electron Security tutorial (17-point checklist + `webPreferences` verification) — https://www.electronjs.org/docs/latest/tutorial/security
  - Electron blog: Webview vulnerability fix (historical CVE context) — https://www.electronjs.org/blog/webview-fix
  - Electron issue #27768 (debugger / auto-attach crash history)
  - Electron PR #24344 (attach/destroy race fix)
  - CDP Overlay — https://chromedevtools.github.io/devtools-protocol/tot/Overlay/
  - CDP Page — https://chromedevtools.github.io/devtools-protocol/tot/Page/
  - CDP Target + flat sessions — https://chromedevtools.github.io/devtools-protocol/tot/Target/
  - Shadow-root piercing via CDP — https://yotam.net/posts/piercing-the-shadow-root-using-cdp/
  - `@medv/finder` (CSS selector generator, v4.x) — https://github.com/antonmedv/finder
- **Cross-cutting (this repo)**:
  - `MEMORY.md` (auto-memory) — performance patterns, terminal-in-splits template, override-system rules, testing rules (`bun run test --conditions=browser`).
  - `docs/plans/2026-04-13-pane-local-frontend-orchestration-plan.md` — per-group rendering context.
  - `docs/layout-engine-group-rendering-rfc.md` — flags `registerTabType` global-state as an antipattern; browser tab becomes its first real caller.
