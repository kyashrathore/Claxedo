# Plugins

The plugin host. It runs the first-party plugins that `bundled.ts` lists from `plugins/` and the user's live plugins from the daemon, and it is the only code that knows a plugin exists. The contract is `@claxedo/plugin-api` (`packages/claxedo-plugin-api`); this folder implements it over the shell's registries.

## Owned concepts

- **Plugin build** (`model.ts`): a manifest, its origin (`bundled`, or `live` with the daemon's bundle hash), the `definePlugin` definition and an optional dictionary. A build's identity is the hash for a live plugin and the manifest version for a bundled one, so every save of a live plugin is a new build.
- **Activation** (`activation.ts`): `activate(api)` runs inside a Solid root that belongs to the plugin, under `catchError`. Every registration goes through the plugin's `RegistrationSink` (`registrations.ts`), and disposing the root disposes every entry, aborts `api.context.signal` and runs the cleanup `activate` returned. A sink refuses registrations after its plugin is disposed.
- **Bindings** (`bindings/`): the `PluginApi` for one build. Entry ids are `<pluginId>/<id>`; theme and icon skin ids stay as given because the theme id is what `data-theme` names, and a taken id is refused. Every page, pane, settings section and overlay view renders inside the plugin's error boundary (`boundary.tsx`). `server.fetch` accepts only same-server paths under a route the manifest names, and `server.operation` only operations it names; both are mistake catchers, not a sandbox.
- **Choices** (`preferences.ts`): per principal scope, through `persistedSignal`: which plugins are switched off (on by default) and which live plugins the user confirmed. Safe mode (`?safe-mode` on the app URL) keeps every live plugin off for that load.
- **Requirements**: `requires` names `Capabilities.features` keys (`tasks`, `documents`). The host re-checks them whenever capabilities change and activates or disposes to match.
- **Host** (`host.ts`, `lifecycle.ts`): one lifecycle per plugin, wanted when switched on, its requirements are met and, for a live plugin, it is confirmed and safe mode is off. A new build activates beside the running one and replaces it only once it activated.
- **Settings → Plugins** (`view/`): every plugin with its origin, version, state and why it is not running; on and off; remove for a live plugin.

## State machine

`PluginState` and `transition` in `model.ts`:

| From | Event | To |
| --- | --- | --- |
| off, loading, failed | switchedOn(build) | loading(build) |
| loading | activated | on(build) |
| loading | activationFailed(reason) | failed(build, reason) |
| on, swapping | swapStarted(to) | swapping(build, to) |
| swapping | activated | on(to) |
| swapping | activationFailed(reason) | on(build, lastFailure) |
| on, swapping | crashed(reason) | failed(build, reason) |
| any | switchedOff | off |

A failed build is not retried until a new build arrives or the plugin is switched off and on. Effects (roots, imports) run in `lifecycle.ts`, outside the transition.

## Live plugins (`live/`)

- The daemon's list (`/api/claxedo/live-plugins`, re-read on `pluginsChanged`) is reconciled with the host: a new hash loads a new build, a removed row drops the plugin, and a failed daemon build keeps the served hash and shows `lastError`.
- A load that fails becomes a build whose `activate` throws, so the machine keeps the running build and shows why. A plugin whose first build failed shows the daemon's error.
- The first time a live plugin appears, the host asks once whether to turn it on; the answer is kept per principal. Settings asks again when an unconfirmed plugin is switched on.
- **Desktop:** the bundle text is fetched through the adapter (the bundle route needs auth), imported from a Blob URL, and runs in the app's realm against `globalThis.__claxedoPluginRuntime` (`live/runtime.ts`).
- **Web:** the bundle never runs in the app's realm. `frame/` runs it in a sandboxed iframe (`sandbox="allow-scripts"`, never same-origin), so it has an opaque origin and cannot read the app's storage or DOM.

## The web frame (`frame/`)

- One hidden control frame per live plugin runs `activate` and forwards its registrations as plain descriptors over a `MessagePort` (`protocol.ts`). The host registers them through the same `PluginApi` a desktop plugin gets, so manifest limits and error boundaries apply unchanged.
- A page, settings section or overlay renders in its own slot frame, which activates the plugin again and renders only that target.
- Plugin functions stay in the frame: commands and mention searches are invoked over the port. Host calls (`server.fetch`, `sessions.create`, `ui.confirm`, …) are answered by the host. Synchronous accessors (projects, tabs, statuses, locale, current session) read a mirror the host pushes on change.
- The frame runtime is `frame/runtime/index.ts`, bundled on its own through Vite's worker build so it has no imports, fetched same-origin by the host, and imported from a Blob URL by the frame's bootstrap. The frame gets the app's stylesheets and theme attributes, so the kit looks native. Panes and icon skins are not available in the frame; the kit's sprite icons cannot load there.
- The Vite dev server serves the frame runtime unbundled, so web live plugins need a built app.

## Server access

`api.ts` is the host's only way to the server. Until the adapter serves `server.plugins`, its calls reject with `AdapterGapError` and the live list is empty.

## Flows

18 Tasks, 19 Pages, 20 on and off, 28 compact tabs, 29 Codex theme, 34 live plugin on desktop, 35 live plugin on the web.
