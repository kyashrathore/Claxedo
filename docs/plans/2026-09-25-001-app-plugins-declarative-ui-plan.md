# App plugins: declarative UI, sandboxed logic (follow-up plan)

Status: planned, not started. Owner ruling 2026-09-25: keep today's app plugins as they are for now (desktop in-app and unsandboxed, with the user warned), and follow up with this design.

## Why

**Today:**
- **Web:** an app plugin runs in a sandboxed frame (`src/plugins/frame`), with its own copy of Solid and the kit.
- **Desktop:** it runs in the app's own JavaScript. It sees everything, and it can reach the internet through the desktop bridge (`openLink`, the browser pane, `webview`, `openPath`), which no Content Security Policy can block.

**The owner's bars for plugins:**
- the network reaches only the app's own server, as the viewing user, no matter what;
- no element re-renders unless it must;
- one model that is cheap and fast on desktop and web.

**The design:** the plugin describes its UI as JSON, the app draws it with its own components, and all plugin code runs sandboxed. That meets all three bars, and the desktop residual goes away.

## Design

### 1. Plugin logic runs in a sandbox, identical on desktop and web
- A Web Worker created inside a sandboxed, opaque-origin frame (`sandbox="allow-scripts"`, `srcdoc`).
- **It can't reach:** the DOM, the desktop bridge, cookies, storage or the network. The inherited CSP blocks every connection.
- **Its only channel** is a `MessagePort` to the app.

### 2. The UI is A2UI v0.9 JSON, drawn with the app's own components
- **Protocol:** [A2UI](https://a2ui.org), pinned at v0.9 (v1.0 is a release candidate; track it).
- **Messages from the plugin:** `createSurface` (surfaceId, catalogId, theme), `updateComponents` (a flat component list with ids and child ids), `updateDataModel` (a JSON Pointer path and a value, upsert semantics, `null` deletes) and `deleteSurface`.
- **Messages to the plugin:** the action (`name`, `surfaceId`, `sourceComponentId` and `context` resolved from the data model when the action fires) and errors. v1.0's request/response is adopted when stable.
- **Our catalog (`catalogId: claxedo/app-v2`):** the kit components a plugin may use, drawn by our Solid renderer. Initial set:
  - text and markdown, heading, icon and badge;
  - button, link, text field, text area, checkbox, toggle, select, radio group and slider;
  - list with templates, row, table, tabs, card, divider and stack/row layout;
  - dialog, empty state and spinner.
- **The catalog is a versioned contract.** A check fails when a catalog component changes shape.
- **No executable code crosses the bridge,** only JSON.

### 3. Every piece of state has one owner

| State | Owner | Messages |
|---|---|---|
| Visual (hover, focus, open menu, scroll, caret) | The app's native component | none |
| Inputs and forms | The surface's data model in the app: a Solid store, with fields bound two-way to paths | none while typing |
| The plugin's own data (lists, selection that matters) | The worker, pushed as `updateDataModel` patches | one per change |
| Persistent plugin settings | Per-user plugin storage in the app, over the bridge | on save |

- **Keystrokes:** typing writes into the store locally. The worker learns the value from an action's `context`, or from a debounced change action where the plugin asks for live input (search as you type).
- **Rendering:** a surface's data model is one Solid store, and each binding reads one path, so a patch to `/items/3/title` re-renders exactly one text node. The component map is keyed by id, and `updateComponents` reconciles by id.

### 4. Registration is declarative
Sidebar items, pages, settings sections, commands and `@` mentions are declared in the manifest. Each page or section is a surface; each handler runs in the worker. Themes stay pure token data.

### 5. Server access goes only through the app
`server.fetch` and `operation` requests go over the bridge. The app checks each one against the manifest's routes and operations, and performs it with the viewing user's credentials, so the worker never holds any.

### 6. Escape hatch
An opt-in `custom-view` component (a sandboxed frame with no network) for canvas or chart needs. The plugin warning names it.

### 7. Authoring from any session
- **Claxedo MCP tools:** `app_plugin.create`, `app_plugin.add` and `app_plugin.check`. `check` validates the surfaces' JSON against the catalog schema, and the manifest (DECISIONS "Owner, 2026-09-25 12:55").
- The `claxedo plugin` CLI is removed.

## Phases and acceptance

- [ ] **P1. Prototype and measure.**
  - **Build:** one real plugin: a sidebar item and a page with a list template, a search field (debounced change action), a button action and one `server.fetch`. It uses A2UI v0.9, the Solid renderer over our catalog, and a worker in an opaque frame, on desktop and web.
  - **Measure, three runs each, in a committed table:** renderer memory with the plugin on and off, activation time, first paint of the page, action round trip, keystroke-to-paint in the bound field, and idle cost (0 frames, 0 timers).
  - **Also measure** today's in-app plugin and web frame plugin with the same fixture, for comparison.
  - Progress:
- [ ] **P2. The owner decides** with P1's numbers. Record it in DECISIONS.
  - Progress:
- [ ] **P3. Renderer and catalog.**
  - The full initial catalog, with a component contract check that fails on a shape change.
  - Unit tests for path binding, templates, `updateDataModel` upsert and delete, and reconciliation by id.
  - Mutation-count tests: a data patch touches only the bound nodes; typing touches only the field.
  - Progress:
- [ ] **P4. Sandbox and bridge.**
  - Worker-in-frame hosting on both platforms.
  - An e2e test that the worker can't `fetch` anything, can't open windows and can't reach `window.api`.
  - Manifest-checked server calls with the viewing user's credentials.
  - Progress:
- [ ] **P5. Registration points,** each proven by a flow assertion from a fixture plugin: sidebar, page, settings section, command, mention, overlay, theme and storage.
  - Progress:
- [ ] **P6. Authoring:** the MCP tools `app_plugin.create`, `add` and `check`; the skill reaches every harness; the CLI is deleted.
  - Progress:
- [ ] **P7. Cut over.**
  - Remove the JSX plugin host (`src/plugins/activation.ts`, `bindings/` render paths, `frame/`, `live/runtime.ts` shared-module runtime) and the in-app desktop path.
  - Update the App plugins warning: plugins now run sandboxed on every platform.
  - No compatibility layer for old plugins.
  - Progress:

## Definition of done
- [ ] One plugin model on desktop and web. No plugin code runs in the app's JavaScript.
- [ ] A plugin can reach only the app's own server, as the viewing user, through the bridge. The sandbox and CSP tests prove every other route is blocked.
- [ ] A data patch or keystroke re-renders only the bound nodes. The budget flows gate it.
- [ ] P1's numbers show the design costs no more memory or start time than today's frame plugins on the web.
- [ ] Any session can create, add and check an app plugin through the MCP tools.
- [ ] The JSX plugin host, the frame host and the CLI are deleted. The line count drops.

## Execution
- **Parallel lanes, each owning its own files:**
  - renderer and catalog (`src/plugins/surface/`);
  - sandbox and bridge (`src/plugins/sandbox/`);
  - MCP tools (`packages/claxedo-mcp`);
  - fixture plugin and flows (`e2e/`).
- **Memory:** one e2e stack at a time on this machine.
- **Runtime tests:** run the agent-sdk-runtime, workspace-runtime and process-ownership test suites only under the no-signal `sandbox-exec` profile.
