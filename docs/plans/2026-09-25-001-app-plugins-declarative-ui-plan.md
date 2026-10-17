# App plugins and agent replies: declarative UI, sandboxed logic

Status: renderer, catalog, agent replies and plugin surface pages built (the P3, P6 and part of P5 work); the P1 measurement table, the worker sandbox (P4) and the cut-over (P8) not started. Owner ruling 2026-09-25: keep today's app plugins as they are for now (desktop in-app and unsandboxed, with the user warned), and follow up with this design. Owner rulings 2026-10-18: the spec is A2UI, drawn by our own Solid renderer, and agent visual replies are a second producer of the same catalog.

## Why

**Today:**
- **Web:** an app plugin runs in a sandboxed frame (`src/plugins/frame`), with its own copy of Solid and the kit.
- **Desktop:** it runs in the app's own JavaScript. It sees everything, and it can reach the internet through the desktop bridge (`openLink`, the browser pane, `webview`, `openPath`), which no Content Security Policy can block.
- **Agents** can answer only with markdown, mermaid and tool rows. A chart, a form or a real diff inline in a reply has no path.

**The owner's bars for plugins:**
- the network reaches only the app's own server, as the viewing user, no matter what;
- no element re-renders unless it must;
- one model that is cheap and fast on desktop and web.

**The design:** a plugin, or an agent, describes UI as data. The app draws it with its own Solid components from one catalog, and all plugin code runs sandboxed. That meets all three bars, removes the desktop residual, and gives agents native UI in the transcript with no second renderer.

## Two mechanisms, one implementation each

| Mechanism | Producers | Owner |
|---|---|---|
| Native surface renderer: one spec, one catalog, Solid | app plugin workers; agents through a Claxedo MCP tool | `src/surface/` (this plan) |
| Sandboxed frame host speaking the MCP Apps bridge | third-party MCP Apps; the `custom-view` component; HTML fallback parts of agent replies | the MCP Apps host plan (`2026-10-18-feat-mcp-apps-host-plan.md`) |

Plugins set the hardest bars (long-lived pages, worker data patches, live typing); agent replies add the token and model-fluency measures.

## Design

### 1. Plugin logic runs in a sandbox, identical on desktop and web
- A Web Worker created inside a sandboxed, opaque-origin frame (`sandbox="allow-scripts"`, `srcdoc`).
- **It can't reach:** the DOM, the desktop bridge, cookies, storage or the network. The inherited CSP blocks every connection.
- **Its only channel** is a `MessagePort` to the app.

### 2. The UI is A2UI v0.9, drawn with the app's own components
- **Protocol:** [A2UI](https://a2ui.org) v0.9.1 (v1.0 is a release candidate; it changes action responses, and is adopted when stable).
- **Messages from the producer:** `createSurface` (surfaceId, catalogId, theme), `updateComponents` (a flat component list with ids and child ids), `updateDataModel` (a JSON Pointer path and a value, upsert semantics, `null` deletes) and `deleteSurface`.
- **Messages to the producer:** the action (`name`, `surfaceId`, `sourceComponentId` and `context` resolved from the data model when the action fires) and errors.
- **Renderer:** ours, in `src/surface/` (its own domain, since the transcript and the plugin host both draw surfaces). The catalog and message schemas are `@claxedo/plugin-api/surface`, shared by the app, the plugin API and `claxedo-mcp`. No official or community A2UI renderer targets Solid. A surface's data model is one Solid store; each binding reads one path; the component map is keyed by id and `updateComponents` reconciles by id.
- **Validation:** zod schemas for the catalog, written by us or generated from A2UI's JSON Schemas. `@a2ui/web_core` 0.14 depends on `lit`, `@lit/context` and `@preact/signals-core`, so the client never imports it; the server-side check may, after a closure review and a proof that it loads in Bun without a DOM.
- **Not chosen:** `@json-render/solid` 0.21.1 keeps a surface's whole state in one signal (`createSignal(snapshot, { equals: false })` in its `StateProvider`), so every state write re-runs every element's prop resolution, against bar 2. OpenUI has no Solid renderer and is shaped for one-shot streamed output.
- **The catalog is a versioned contract.** A check fails when a catalog component changes shape. Initial set:
  - text and markdown (drawn by the transcript's own markdown pipeline, `src/transcript/markdown*`), heading, icon and badge;
  - button, link, text field, text area, checkbox, toggle, select, radio group and slider;
  - list with templates, row, table, tabs, card, divider and stack/row layout;
  - empty state and spinner;
  - reference components that read real objects with the viewer's own access: `Diff`, `FileRef`, `SessionRef`.
- **No dialog, toast, context menu or overlay component.** A surface never opens UI over the app.
- **No executable code crosses the bridge,** only data.

### 3. Every piece of state has one owner

| State | Owner | Messages |
|---|---|---|
| Visual (hover, focus, open menu, scroll, caret) | The app's native component | none |
| Inputs and forms | The surface's data model in the app, with fields bound two-way to paths | none while typing |
| The plugin's own data (lists, selection that matters) | The worker, pushed as data patches | one per change |
| Persistent plugin settings | Per-user plugin storage in the app, over the bridge | on save |
| An agent reply's spec | The tool part's input in the session transcript | none after the call |
| An agent form's answer | The session's request store (`src/session/requests/`), as a question reply | one on submit |

- **Keystrokes:** typing writes into the data model locally. The worker learns the value from an action's `context`, or from a debounced change action where the plugin asks for live input (search as you type).
- **Rendering bar:** a patch to `/items/3/title` re-renders exactly one text node, and typing re-renders only the field. P1 measures the renderer against this bar.

### 4. Registration is declarative
Sidebar items, pages, settings sections, commands and `@` mentions are declared in the manifest. Each page or section is a surface; each handler runs in the worker. Themes stay pure token data.

### 5. Server access goes only through the app
`server.fetch` and `operation` requests go over the bridge. The app checks each one against the manifest's routes and operations, and performs it with the viewing user's credentials, so the worker never holds any.

### 6. Escape hatch: `custom-view`
An opt-in component for canvas or chart needs. It is the MCP Apps host plan's sandboxed frame, with no network, placed inside a surface; this plan builds no frame of its own. The plugin warning names it. Agent replies use the same component for HTML fallback parts.

### 7. Surfaces cannot impersonate the app
- Every surface from a plugin or an agent draws inside a container marked with its source (the plugin's name, or the agent's harness), in every theme.
- No catalog component draws like a permission or question request, and no surface action answers a request.
- A surface action that runs a server operation or sends a message confirms through `requestConfirm` (`src/ui/confirm.tsx`) unless the manifest or the tool marks it read-only.

### 8. Agent replies: a second producer
- **Tool:** a Claxedo MCP tool (working name `ui_show`, in `packages/claxedo-mcp`) whose input is the surface spec and a title. A check tool validates a spec against the catalog and returns each error with its path, without showing anything.
- **Transcript:** the spec is the tool part's input, so it survives reload, sharing and the stored copy of a stopped cloud session with no new storage.
  - The read sends a `ui_show` part whole: it joins `WHOLE` or `CLAXEDO_RESULT_ROWS` in `toolPartHeader` (`packages/agent-runtime-contract/src/tool-header.ts`), whose read is `headed()` in `turn-page.ts`.
  - The turn fold treats it as part of the answer: `answerGroups` (`turn-fold.ts`) keeps it with the final text.
  - The tool row picks the surface renderer before `ClaxedoTool` (`ToolPartDisplay`, `src/transcript/message-part.tsx`). The renderer lives in its own files, since `message-part.tsx` is already 2185 lines.
- **Forms:** an agent form is a richer question. It is shown and answered through `src/session/requests/`, so its answer reaches the agent as a question reply and survives reload.
  - **Built instead, for now:** a reply surface's Button action asks the reader through `requestConfirm`, then sends one user message, `Surface action "<name>" on "<title>": <context JSON>`, as the reader. It needs no blocking tool call and works on every harness; a reader who cannot send sees the buttons disabled. The request-store form stays the target.
- **Open owner question:** whether a reply surface counts as answer content (sent whole on the first page, as above) or as a tool body (loaded only when the reader expands it). This plan assumes answer content.

### 9. Authoring from any session
- **Today:** `app_plugin_create`, `app_plugin_check`, `app_plugin_add` and `app_plugin_guide` exist in `packages/claxedo-mcp/src/tools/app-plugins.ts`; `check` typechecks a JSX plugin against `@claxedo/plugin-api` and Solid and builds it. There is no `claxedo plugin` CLI.
- **After cut-over:** `app_plugin_check` validates the surfaces' data against the catalog schema, and the manifest (DECISIONS "Owner, 2026-09-25 12:55").

## Phases and acceptance

- [ ] **P1. Prototype and measure.** Built on a branch of its own; nothing in it ships. Each benchmark run takes at most 10 minutes including launch.
  - **Fixture plugin:** a sidebar item and a page with a list template, a search field (debounced change action), a button action and one `server.fetch`, with the worker in an opaque frame, on desktop and web. It uses A2UI v0.9 and the Solid renderer over a catalog subset (text, button, text field, list with template, row, card).
  - **Agent-reply fixture:** the `ui_show` tool and its transcript renderer, with three reference replies: a metrics table, a three-field form, and a `Diff` reference.
  - **Plugin measures, the prototype and today's in-app and web frame plugins with the same fixture, three runs each, in a committed table:**
    - renderer memory with the plugin on and off;
    - activation time and first paint of the page;
    - action round trip and keystroke-to-paint in the bound field;
    - idle cost (0 frames, 0 timers);
    - DOM mutations and memo or effect runs per data patch to one list item, and per keystroke, counted on a 200-item list;
    - production bundle bytes added, minified and gzipped;
    - `bun run test:architecture-ratchets` closure change.
  - **Agent measures:**
    - catalog prompt size in tokens (the catalog schema and instructions the tool description carries), counted by each model's token counter;
    - output tokens for each reference reply;
    - over a fixed set of 20 prompts on two models (one Claude model through Claude Code, one GPT model through Codex): the share of calls whose spec validates on the first try, and after one check round;
    - time from tool call to painted surface in the transcript.
  - **Mechanism note:** the table records what a patch and a keystroke actually re-run, read from the code and confirmed by the counts.
  - Progress: the measurement table is not run (benchmarks run only when asked). The mechanism is proven by a unit test instead: a patch to `/items/3/title` re-runs one of 202 bound readers, and a 200-item list template keeps every other item. The `ui_show` tool description plus its input schema is 1,477 + 14,855 characters.
- [ ] **P2. The owner reviews** P1's table and approves P3 onward, or names what changes first. Record the numbers and the ruling in DECISIONS.
  - Progress:
- [ ] **P3. Renderer and catalog.**
  - The full initial catalog, with a component contract check that fails on a shape change.
  - Unit tests for path binding, templates, data patch upsert and delete, and reconciliation by id.
  - Mutation-count tests: a data patch touches only the bound nodes; typing touches only the field.
  - The source-marked container (§7) in light and dark themes.
  - Progress: built. The catalog (`packages/claxedo-plugin-api/src/surface/catalog.ts`) is the A2UI v0.9 basic set over the opencode UI kit without Image, Video, AudioPlayer (the network lock) and Modal (no overlays), plus Markdown, Code, Badge, Link, Switch, Progress, Spinner, Table, DiffStat, EmptyState and Collapsible; the reference components (`Diff`, `FileRef`, `SessionRef`) are not built. The zod schemas are the contract check. Unit tests cover path binding, relative template scopes, data-model upsert, delete and whole replace, reconciliation by id and the reader counts above; every surface draws in a container marked with its source.
- [ ] **P4. Sandbox and bridge.**
  - Worker-in-frame hosting on both platforms.
  - An e2e test that the worker can't `fetch` anything, can't open windows and can't reach `window.api`.
  - Manifest-checked server calls with the viewing user's credentials.
  - Progress: not started. A surface page's logic runs where the plugin runs today: in the web control frame (only data crosses the port) and in-app on the desktop.
- [ ] **P5. Registration points,** each proven by a flow assertion from a fixture plugin: sidebar, page, settings section, command, mention, overlay, theme and storage.
  - Progress: pages only. A page registered with `surface(channel, props)` instead of `render` is drawn natively on both platforms (`src/plugins/surface-page/`, `src/plugins/frame/host-surfaces.ts`); flow 61 (web and phone) opens it from the sidebar, finds no iframe in it, and gets a new item back from the plugin's action.
- [ ] **P6. Agent replies.**
  - `ui_show` and its check tool in `packages/claxedo-mcp`; the `toolPartHeader`, `answerGroups` and renderer-choice changes of §8.
  - A flow: an agent reply's surface paints on the first page after a session switch, stays out of the fold, and renders the same after reload and for a shared-session reader.
  - A flow: an agent form is answered through the request store and the agent receives the answer.
  - Negative flows: an invalid spec is refused by the check tool with paths; a surface action that sends a message asks first and does nothing when declined.
  - Progress: built, with the form difference recorded under §8. `ui_show` validates the graph and answers each issue by JSON Pointer; a reply surface is answer content in the fold (`ANSWER_TOOLS`, `turn-fold.ts`). Flow 60 (web and phone) paints the reply, sends nothing on Cancel, posts the typed value on Confirm, and repaints after a reload; its red run is the egress-refused model turn.
- [ ] **P7. Authoring:** `app_plugin_check` validates surfaces against the catalog; the guide (`app-plugins-guide.ts`) and the skill teach the new model in every harness.
  - Progress: the guide teaches surface pages, and `app_plugin_check` typechecks a surface plugin against the catalog's types; the skill is not updated.
- [ ] **P8. Cut over.**
  - Remove the JSX plugin host (`src/plugins/activation.ts`, `bindings/` render paths, `frame/`, `live/runtime.ts` shared-module runtime) and the in-app desktop path.
  - Update the App plugins warning: plugins now run sandboxed on every platform.
  - No compatibility layer for old plugins.
  - Progress:

## Definition of done
- [ ] One plugin model on desktop and web. No plugin code runs in the app's JavaScript.
- [ ] A plugin can reach only the app's own server, as the viewing user, through the bridge. The sandbox and CSP tests prove every other route is blocked.
- [ ] A data patch or keystroke re-renders only the bound nodes. The budget flows gate it.
- [ ] P1's numbers show the design costs no more memory or start time than today's frame plugins on the web.
- [ ] Plugins and agent replies draw through one renderer and one catalog; no second renderer exists.
- [ ] No surface can draw over the app or answer a permission or question request; every surface carries its source mark.
- [ ] Any session can create, add and check an app plugin, and show a reply surface, through the MCP tools.
- [ ] The JSX plugin host and the frame host are deleted. The line count drops.
- [ ] `bun run check`, `bun run typecheck` and `bun run test` in `packages/claxedo-app`, and `bun run test:architecture-ratchets` at the repo root, pass on the merge tip; every new or changed flow has a recorded red run, at desktop width and in `phone`.

## Execution
- **P1 runs as three parallel lanes in separate worktrees:** the renderer and fixture plugin (`src/surface/`, the fixture); the agent-reply fixture (`ui_show`, the transcript renderer files); and the measurement harness with the committed table, which runs both. Agents run the 20-prompt set in parallel per model.
- **After P2, parallel lanes, each owning its own files:**
  - renderer and catalog (`src/surface/`);
  - sandbox and bridge (`src/plugins/sandbox/`);
  - agent replies (`packages/claxedo-mcp` `ui_show`, `packages/agent-runtime-contract` header and fold, the transcript renderer files);
  - fixture plugin and flows (`e2e/`).
- **Memory:** one e2e stack at a time on this machine; at most two lanes run tests at once.
- **Runtime tests:** run the agent-sdk-runtime, workspace-runtime and process-ownership test suites only under the no-signal `sandbox-exec` profile.
