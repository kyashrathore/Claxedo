# Plugins

The plugin host. It runs the four first-party plugins from `plugins/` and the user's live plugins from the daemon, and it is the only code that knows a plugin exists.

## Owned concepts

- **Plugin manifest**: the `claxedo` block of a plugin's `package.json` (`id`, `name`, `version`, `requires`, `routes`, `operations`). `manifest.ts` reads and checks it.
- **Plugin API** (`api.ts`): everything a plugin may touch. First-party and user plugins get the same API. A primitive is added only when a plugin needs it, and the plan's primitive table changes in the same commit.
- **Activation**: `activate(api)` runs inside a Solid root owned by the plugin. Every registration is tagged with the plugin id and disposed with the root.
- **Registrations**: entries the plugin adds to the shell registries (`src/shell/types.ts`). Every contribution's view renders inside the plugin's error boundary (`boundary.tsx`).
- **Enablement**: per user, through `makePersisted`, on by default. Safe mode (`?safe` on the app URL) treats every user plugin as off for that load.
- **Requirements**: `requires` names `Capabilities.features` keys; the host re-checks them when capabilities change and activates or disposes to match.
- **Server access**: `api.server` goes through the adapter and refuses a route or operation the manifest does not name. It is a mistake catcher, not a sandbox.
- **Live plugins**: listed from the daemon, imported by hashed bundle URL, swapped on `pluginsChanged`. A version that fails to activate leaves the old one on and records the failure.
- **Realms**: bundled plugins and desktop user plugins run in the app's JavaScript with a runtime global for `solid-js` and the API. On the web a user plugin runs in a sandboxed iframe (`sandbox="allow-scripts"`, never same-origin) behind a `postMessage` bridge that carries the API, limited to the manifest, and the v2 tokens.

## State machine

`PluginState` in `api.ts`, transition in `model.ts`:

| From | Event | To |
| --- | --- | --- |
| off | switchOn(version) | loading(version) |
| loading | activated | on(version) |
| loading | activationFailed(reason) | failed(reason, version) |
| on | swap(to) | swapping(version, to) |
| swapping | activated | on(to) |
| swapping | activationFailed(reason) | on(version, lastFailure) |
| on, loading, swapping, failed | switchOff | off |
| failed | switchOn(version) | loading(version) |

Effects (creating and disposing roots, importing bundles) run outside the transition, in `host.ts`.

## Flows

18 Tasks, 19 Pages, 20 on and off, 28 compact tabs, 29 Codex theme, 34 live plugin on desktop, 35 live plugin on the web.
