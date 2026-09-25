# Live plugins (daemon side)

The machine owner's registry of plugin folders, their builds, and the notice that tells the app a build changed.

## Owned concepts

- **Registry**: `<dataDir>/live-plugins/registry.json`, one entry per folder (`id`, real `directory`, `addedAt`). Belongs to the machine's owner; a signed composition must supply `authorizeMachineOwner` or every signed caller is refused.
- **Bundle store**: `<dataDir>/live-plugins/bundles/<id>/<hash>/app.js`, immutable per hash, plus `current.json` naming the last good build (its hash, the manifest it was built from and when) so a restart serves it before the first rebuild.
- **Served manifest**: every row carries the manifest the served bundle was built from and its build time. The app approves a plugin against this manifest, so it must be the one the code was built with, not the folder's current `package.json`.
- **Source view** (`source.ts`): the owner reads a plugin's files without leaving its registered folder. Paths are relative with no `.`, `..`, empty or backslash segment; any symbolic link on the way is refused (the listing skips them); `node_modules`, `.git` and `dist` are never listed or read; a file over 256 KiB or with a NUL byte is refused; a folder that became a symbolic link after registration is refused.
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
| `GET /:id/source` | `{ files: [{ path, size }], truncated }`; `404` unknown; `403` the folder became a symbolic link |
| `GET /:id/source/file?path=<relative>` | `{ path, size, text }`; `400` a path that leaves the folder; `403` a symbolic link or a skipped folder; `404` missing or not a file; `413` over 256 KiB; `415` binary |
| `GET /:id/:hash/app.js` | the bundle, `cache-control: public, max-age=31536000, immutable`; `404` unknown hash |

Every route belongs to the machine's owner: unsigned, the loopback gate is the only way in; signed, `authorizeMachineOwner` must accept the caller, and a composition that supplies none refuses every signed caller.

The path is `live-plugins`, not `plugins`: `/api/claxedo/plugins` is the Marketplace (Agent Plugins) family.

## The authoring skill

`skills/claxedo-plugin-authoring/SKILL.md` reaches every session through `withLivePluginSkills`, which appends `skills/` to `harnessLaunch.opencode.config.skills`, the same launch document Agent Plugins' skills use. A packaged daemon must ship the `skills/` folder next to its bundle.
