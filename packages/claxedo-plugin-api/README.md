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
| `server.operations` | Control-plane operations `api.server.operation` may run; `documents.*` allows a namespace. Results are `unknown`; the plugin validates the response before using it. |
| `backend` | Optional. A backend the hosted Worker loads per organization: `entry` (the module, relative to the package root), `objects` (the Durable Object classes it exports), `outbound` (the hosts it may fetch over https) and `routes` (`METHOD /path` patterns, where `:name` matches one segment and a trailing `*` one or more). `packages/claxedo-server/src/plugin-backends/README.md` describes the platform. |

`readPluginManifest(packageJson)` validates the block and throws `PluginManifestError` with one issue per problem. `pluginBackendRouteAllowed(backend, method, path)` answers whether a request matches a declared backend route.

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

## Terminal status templates

`StatusHookTemplate` declares how one CLI reports terminal status: `command`, `provider`, optional command `aliases`, `install`, `events` and `subagent` payload fields. A template defines shell wrappers and rewrites files in the person's home, so templates are honored only from `@claxedo/status-hooks`, the package bundled with Claxedo, which the runtime imports directly. A plugin manifest that declares `claxedo.statusHooks` is refused: `readPluginManifest` throws `PluginStatusHooksRefusedError` (code `status_hooks_first_party_only`), `pluginManifestSchema` fails at every other parse site, and a plugin build reports a `manifest` diagnostic with that code. `readStatusHookTemplates` validates the bundled package's templates.

`install.type` is one of:

- `wrapper-flags`: `args` added by the binary wrapper.
- `config-merge`: `path` rooted at `~/`, `entries`, and a `shape` of `flat`, `nested`, `named`, or `text`. JSON entries use `base` to name their container and `managedScript` to identify owned registrations. A text install requires `ownedPrefix`. `effectiveFile` selects an existing alternate config and retires only owned registrations in the primary file; `defaults` sets absent or wrongly typed metadata.
- `project-file`: a project-relative `path`, JSON `entries`, and the declared `hookFile` artifact. The wrapper writes the file only inside a terminal tab and adds its path to `.git/info/exclude` without changing other entries.

`events` maps CLI event names to `running`, `waiting`, `done`, or `ignored`. A rule may carry `outcome` (`done`, `error`, `cancelled`), `when` payload-field predicates, `toolCompletion`, and a nested `payload` descriptor for session identity. An ordered rule array selects the first matching predicate. `subagent` names payload fields marking child work; core permits only a child's asks and matching tool completions to affect the parent terminal.

`artifacts` declares hook filenames, text and modes. Template values support `{{notify}}`, `{{hooks}}`, `{{notifyCommand}}` and artifact filenames as variables; `|sh` shell-quotes and `|json` JSON-quotes a value. Wrapper text can refer to `{{args}}` (the quoted argument list), `{{arg0}}` and subsequent argument values, and `{{projectInstall}}` (shared project-file installation). With no wrapper text, the engine uses its standard wrapper. `wrapper: false` installs config without wrapping the command. `replayGuard.env` identifies a foreign CLI's environment marker for rejecting replayed hooks.
