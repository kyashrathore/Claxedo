# Live plugins (daemon side)

The machine owner's registry of plugin folders, their builds, and the notice that tells the app a build changed.

## Owned concepts

- **Registry**: `<dataDir>/live-plugins/registry.json`, one entry per folder (`id`, real `directory`, `addedAt`). Belongs to the machine's owner; a signed composition must supply `authorizeMachineOwner` or every signed caller is refused.
- **Bundle store**: `<dataDir>/live-plugins/bundles/<id>/<hash>/app.js`, immutable per hash, plus `current.json` naming the last good build (its hash, the manifest it was built from and when) so a restart serves it before the first rebuild.
- **Served manifest**: every row carries the manifest the served bundle was built from and its build time. The app approves a plugin against this manifest, so it must be the one the code was built with, not the folder's current `package.json`.
- **Build state** (`machine.ts`), one per plugin:
  - `building { last? }` → `ready { bundle }` on `buildSucceeded`, or `failed { error, last? }` on `buildFailed`.
  - `last` is the bundle still served while a build runs or after one fails; a failure never drops it.
  - A manifest whose `id` differs from the registered one fails the build, because the id is the registry key.
- **Watcher**: one debounced recursive watch per folder (`@claxedo/plugin-build`), ignoring `node_modules`, `dist` and `.git`; non-persistent, so it never keeps the daemon alive.
- **Notice**: `plugins.changed { pluginId, status, hash?, ts }` on the control bus (`cp/events`), rung on every state change and on removal. It is a doorbell; the app re-reads the list. `event-visibility.ts` keeps it from signed subscribers, so a user's plugins reach only that user's app.

## Routes (`/api/claxedo/live-plugins`)

| Route | Answer |
| --- | --- |
| `GET /` | `{ plugins: [{ id, name, version, directory, status, hash, url, manifest, builtAt, lastError }] }` |
| `POST /` `{ directory }` | `201` with the row after its first build; `400` relative path, not a folder, or an invalid manifest (the messages); `404` missing folder; `409` id or folder already registered |
| `DELETE /:id` | `204`; `404` unknown |
| `GET /:id/:hash/app.js` | the bundle, `cache-control: public, max-age=31536000, immutable`; `404` unknown hash |

Every route belongs to the machine's owner: unsigned, the loopback gate is the only way in; signed, `authorizeMachineOwner` must accept the caller, and a composition that supplies none refuses every signed caller.

The path is `live-plugins`, not `plugins`: `/api/claxedo/plugins` is the Marketplace (Agent Plugins) family.

## Authoring from a session

A session makes an app plugin through the Claxedo MCP tools `app_plugin_create`, `app_plugin_check`, `app_plugin_add` and `app_plugin_guide` (`packages/claxedo-mcp/src/tools/app-plugins.ts`), which carry the authoring guide to every harness that connects to the MCP server. The tools call `appPluginAuthoring` (`authoring.ts`), the grant a composition builds for one session:

- **Who gets it.** Only sessions driven by the machine owner. `SessionAuthoringOwnership` retains the verified actor at durable queue admission, before harness dispatch, and reads turn-journal actors plus session ancestry. Steering and removal of a queue row cannot erase that provenance. The control plane includes the enrollment owner's actor ID in its machine-heartbeat credential; the daemon compares relay actors against that ID, never against workspace roles. Unknown relay owners and missing ancestors fail closed. MCP connections refresh their tool visibility and authorization on every request, including connections opened before a session exists. The self-hosted node additionally requires an operator-owned workspace. `session_create` and `task_start` refuse detached root creation by a member-driven session. Such sessions delegate through `subagent_spawn`, whose canonical parent preserves provenance; owner-driven root creation keeps its existing placement behavior. Hosted/cloud compositions without a local daemon grant no authoring.
- **Where it may write.** The grant is bound to the session's workspace folder. Every path is resolved through symlinks and refused outside it; `create` refuses a folder with content and an id the daemon already serves. The default folder is `<workspace>/.claxedo/plugins/<id>`.
- **What each step does.** `create` writes `package.json` (the manifest) and `src/app.tsx` (a page and a sidebar item) from `scaffold.ts`. `check` runs `checkPluginApp` from `@claxedo/plugin-build`: a typecheck against the daemon's own plugin API and Solid, then a build, answered as file, line, column and message. `add` is `LivePluginService.add`, the same call `POST /` makes, so the registry, the first build, the watcher and `plugins.changed` are the ones described above.

Claude Code and Codex receive the session-bound Claxedo MCP server in their native launch configuration. OpenCode installs the SDK tool transform and session-context filter in `workspace-runtime/src/opencode/first-party-mcp.ts`; Pi loads the extension owned by `agent-sdk-runtime/src/harnesses/pi/first-party-mcp.ts`. Both connect before the model turn, using the same first-party credential provider, and the daemon remains authoritative for access on every call. The guide is an MCP tool, so it needs no harness-specific skill installation.

**Prompt injection.** A model can be talked into making or adding a plugin by text it reads: a file, a web page, an issue, a tool result. The guide tells it to act only on the person's request, but the model is not the boundary. The app is: a newly registered plugin, or a build whose manifest asks for different access, runs only after the owner turns it on in a dialog that names what it may reach. Registering a folder never activates it, and the folder is limited to the session's own workspace, so a tricked session can at most put a plugin in front of that dialog.
