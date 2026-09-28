# @claxedo/plugin-api

The contract between a Claxedo plugin and the app that hosts it. Every plugin is a user plugin registered with the daemon.

## The manifest

A plugin is a package whose `package.json` carries a `claxedo` block:

```json
{
  "name": "claxedo-plugin-notes",
  "version": "0.1.0",
  "claxedo": {
    "id": "notes",
    "name": "Notes",
    "version": "0.1.0",
    "app": "./src/app.tsx",
    "requires": ["documents"],
    "server": {
      "routes": ["/api/claxedo/tasks"],
      "operations": ["documents.*"]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and dashes, at most 64 characters. The key of every registry entry the plugin makes. |
| `name` | Shown in Settings → Plugins. |
| `version` | Semantic version of the plugin. |
| `app` | The app entry, relative to the package root, whose default export is `definePlugin(...)`. |
| `requires` | Capabilities the connected server must have before the plugin activates: `tasks`, `documents`. |
| `server.routes` | Claxedo server route prefixes `api.server.fetch` may call. |
| `server.operations` | Control-plane operations `api.server.operation` may run; `documents.*` allows a namespace. |

`readPluginManifest(packageJson)` validates the block and throws `PluginManifestError` with one issue per problem.

## The API

`activate(api)` receives one `PluginApi`. Every `register` and `item` call returns a disposer; the host also disposes everything a plugin registered when it is switched off, replaced by a newer build, or fails.

| Primitive | Purpose |
| --- | --- |
| `sidebar.item` | A row in the main sidebar that opens a page |
| `pages.register`, `pages.open` | A page in the page tab, with its own path |
| `panes.register`, `panes.open` | A pane kind in the workbench, with its restore state |
| `settings.section` | A section in the settings sidebar and page |
| `overlays.register`, `overlays.open`, `overlays.close` | A keyboard-invoked overlay |
| `commands.register`, `commands.run` | Commands with keybindings |
| `mentions.register` | Items in the composer's `@` menu |
| `workbench` | List tabs with status, activate, close, move |
| `themes.register`, `icons.registerSkin` | Themes and icon skins |
| `sessions` | Create with a prompt and attachments, status, open |
| `projects` | List, and the current project's id |
| `server` | `fetch` and `operation`, limited to what the manifest names |
| `context` | Plugin id and version, platform, locale, current project and session, an abort signal disposed with the plugin |
| `ui` | `toast`, `confirm` |
| `i18n` | `t` |

## The runtime global

Built plugin bundles do not carry `solid-js`, `solid-js/web`, `solid-js/store`, `@claxedo/plugin-api` or `@claxedo/app/ui`. The host installs those five modules on `globalThis.__claxedoPluginRuntime`, keyed by specifier, before it imports a bundle. `PLUGIN_RUNTIME_MODULES` is the one list both the build and the host read.
