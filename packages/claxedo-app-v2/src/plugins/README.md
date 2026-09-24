# Plugins

The plugin host. It runs the four first-party plugins from `plugins/` and the user's live plugins from the daemon, and it is the only code that knows a plugin exists. The contract is `@claxedo/plugin-api` (`packages/claxedo-plugin-api`); this folder implements it over the shell's registries.

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

## Server access

`api.ts` is the host's only way to the server. Until the adapter serves `server.plugins`, its calls reject with `AdapterGapError`.

## Flows

18 Tasks, 19 Pages, 20 on and off, 28 compact tabs, 29 Codex theme, 34 live plugin on desktop, 35 live plugin on the web.
