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

A session makes an app plugin through the Claxedo MCP tools `app_plugin_create`, `app_plugin_check` and `app_plugin_add` (`packages/claxedo-mcp/src/tools/app-plugins.ts`), which carry the authoring guide to every harness that connects to the MCP server. The tools call `appPluginAuthoring` (`authoring.ts`), the grant a composition builds for one session:

- **Who gets it.** Only a session of the machine's owner, the same caller the routes above admit. On the desktop the routes admit loopback callers only (they are mounted without `authorizeMachineOwner`, so every signed caller is refused), and the grant follows the same line: a session is granted only while no relayed turn has reached it or a session above it (`drivenOnlyByMachineUser`, read from the runtime journal's `turn.start` rows, which carry an `actorId` only when the relay boundary named the caller). That refuses a member the session was shared with and also the owner's own turns sent through the relay from the web app: the daemon holds no identity of its own person to compare a relayed author against (its serving identity is a host id and a relay URL, and a relay token's role is an org rank, not machine ownership), so it fails closed rather than guess. The runtime records the turn before it launches the harness, so the first relayed turn is on file before that turn's harness connects and lists tools, and the grant asks again on every call, so a connection opened before the relayed turn is refused after it. The self-hosted node grants a session whose workspace an operator (`CLAXEDO_OPERATOR_SUBJECTS`) owns, or every session when it runs unsigned. A cloud runtime and the hosted worker have no daemon of their own and grant none, so the tools are not listed there.
- **Where it may write.** The grant is bound to the session's workspace folder. Every path is resolved through symlinks and refused outside it; `create` refuses a folder with content and an id the daemon already serves. The default folder is `<workspace>/.claxedo/plugins/<id>`.
- **What each step does.** `create` writes `package.json` (the manifest) and `src/app.tsx` (a page and a sidebar item) from `scaffold.ts`. `check` runs `checkPluginApp` from `@claxedo/plugin-build`: a typecheck against the daemon's own plugin API and Solid, then a build, answered as file, line, column and message. `add` is `LivePluginService.add`, the same call `POST /` makes, so the registry, the first build, the watcher and `plugins.changed` are the ones described above.

**Prompt injection.** A model can be talked into making or adding a plugin by text it reads: a file, a web page, an issue, a tool result. The guide tells it to act only on the person's request, but the model is not the boundary. The app is: a newly registered plugin, or a build whose manifest asks for different access, runs only after the owner turns it on in a dialog that names what it may reach. Registering a folder never activates it, and the folder is limited to the session's own workspace, so a tricked session can at most put a plugin in front of that dialog. One path the desktop's grant does not follow: a session a member drives can start a new root session with `session_create` and prompt it; that prompt reaches the runtime in process, as the machine's own user, and nothing records which session started the new one, so it reads as the owner's. Closing it needs the runtime to record an in-process caller session as the turn's actor, which is a contract across `@claxedo/mcp`, the daemon's dispatch and the runtime. The dialog still stands in front of anything such a session adds.
