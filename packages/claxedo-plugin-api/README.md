# @claxedo/plugin-api

The contract between a Claxedo app plugin and the app that hosts it. A plugin is either first-party, a workspace package the app ships as a bundle (Tasks, `@claxedo/tasks`, and Documents, `@claxedo/documents`), or a live plugin, a folder the machine's owner registered with the daemon. Both kinds get the same API. `FIRST_PARTY_PLUGIN_IDS` (`claxedo-tasks`, `claxedo-documents`) reserves the first-party ids: the daemon refuses a live plugin that takes one.

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
| `id` | Lowercase letters, digits and dashes, at most 64 characters, and not one of `FIRST_PARTY_PLUGIN_IDS` for a live plugin. The key of every registry entry the plugin makes. |
| `name` | Shown in Settings → App plugins. |
| `version` | Semantic version of the plugin. |
| `app` | The app entry, relative to the package root, whose default export is `definePlugin(...)`. |
| `requires` | Server capabilities the plugin needs before it activates, as open ids (`^[a-z][a-z0-9-]*$`). One is offered when the server's bootstrap lists it in `deployment.capabilities`, which names the capability of each first-party server plugin it mounted: `tasks`, `documents`. |
| `server.routes` | Claxedo server route prefixes `api.server.fetch` may call. |
| `server.operations` | Control-plane operations `api.server.operation` may run; `documents.*` allows a namespace. Results are `unknown`; the plugin validates the response before using it. |
| `permissions` | Optional. The platform calls the backend may make, from `PLUGIN_PERMISSIONS`: `projects.read`, `sessions.read`, `sessions.start`, `workspaces.cloud`, `tools`, `blobs`, `events`, `schedule`, `links`, `session-files`. A call whose permission is not listed is refused. |
| `backend` | Optional. A backend the hosted Worker loads per organization: `entry` (the module, relative to the package root), `objects` (the Durable Object classes it exports), `outbound` (the hosts it may fetch over https), `routes` (`METHOD /path` patterns, where `:name` matches one segment and a trailing `*` one or more, never under `/_`, which is the platform's) and optionally `tools` (a `group` with `id` and `label`, and the `definitions` module). `packages/plugin-runtime/README.md` describes the runtime and `packages/claxedo-server/src/plugin-backends/README.md` the hosted Worker around it. |

`readPluginManifest(packageJson)` validates the block and throws `PluginManifestError` with one issue per problem. `pluginBackendRouteAllowed(backend, method, path)` answers whether a request matches a declared backend route.

## The API

`activate(api)` receives one `PluginApi`. Every `register` and `item` call returns a disposer; the host also disposes everything a plugin registered when it is switched off, replaced by a newer build, or fails.

| Primitive | Purpose |
| --- | --- |
| `sidebar.item` | A row in the main sidebar that opens a page |
| `pages.register`, `pages.open` | A page with its own path, rendered or a surface page (`surface(channel, props)`). A surface page with `tab: true` opens in the page tab the app's own tab pages share, and `icon` names its glyph. A path with params (`/tasks/:taskId?`) keeps one program while the params change: the host calls `navigated(props)` instead of opening it again |
| `panes.register`, `panes.open` | A pane kind in the workbench, with its restore state |
| `settings.section`, `settings.open` | A section in the settings sidebar and page, rendered (`render`) or a surface (`surface(channel)`, with an optional `group`, `workspace` or `app`); `open` shows one of the plugin's sections |
| `overlays.register`, `overlays.open`, `overlays.close` | A keyboard-invoked overlay |
| `commands.register`, `commands.run` | Commands with keybindings |
| `mentions.register` | Items in the composer's `@` menu |
| `workbench` | List tabs with status, activate, close, move |
| `themes.register`, `icons.registerSkin` | Themes and icon skins |
| `sessions` | Create with a prompt and attachments, status, open (also a session the app has not listed yet: the host rereads the workspace catalog once, then navigates) |
| `workspaces` | `followStart(workspaceId, onProgress)`: follow a cloud workspace's start, with each step in the words the session screen uses, until it runs or fails |
| `projects` | List, and the current project's id |
| `server` | `fetch` and `operation`, limited to what the manifest names; a response body arrives byte for byte on every platform |
| `context` | Plugin id and version, platform, locale, current project and session, an abort signal disposed with the plugin |
| `ui` | `toast`, `confirm` |
| `i18n` | `t` |
| `transcript` | `toolCards(templates)`: declarative cards for the plugin's agent tools in the transcript (`transcript.ts`, checked by `readToolCardTemplates`): a title, subject, status with its glyphs and tones, facts, rows and links to the plugin's page or a session, read by JSON Pointer from the tool's `{ args, result }`. A tool that already has a card is refused |

## Surfaces

`@claxedo/plugin-api/surface` is the A2UI v0.9 contract an agent's `ui_show` reply and a plugin's surface page share: the catalog (`catalog.ts`), the messages (`messages.ts`), the spec check (`spec.ts`), and `SURFACE_DESIGN_GUIDE` (`design-guide.ts`), the design guidance the `ui_guide` MCP tool serves. Every recipe in the guide is a complete spec that `design-guide.test.ts` checks.

## Backends

`@claxedo/plugin-api/backend` is what a backend is written against. `definePluginBackend({ fetch(request, platform), wake?(name, payload, platform), tool?(name, args, platform) })` is its default export:

- a request to one of the manifest's routes reaches `fetch`, with the platform bound to that request's caller handle;
- a due wake reaches `wake`, once, with a `system` caller;
- an agent's call of one of the release's tools reaches `tool` with the call's arguments, as an `agent` caller, and its `PluginToolResult` (an MCP tool result: text and PNG or JPEG image blocks, `isError` optional) is the answer; a backend without `tool` answers 404 `plugin_tool_not_served`.

**Agent tools.** The manifest's `backend.tools` names a `group` (`id`, `label`) and the `definitions` module, whose default export is the array of `PluginToolDeclaration`s: `name` (`PLUGIN_TOOL_NAME_PATTERN`, `^[a-z][a-z0-9_]{1,47}$`), `title`, `description`, `inputSchema` (a JSON Schema object) and `access` (`read` or `write`). The release build evaluates that module once and carries the declarations as `release.tools`, so no host runs plugin code to learn its tools. `@claxedo/plugin-api/tools` holds the contract the platform's MCP proxy and the host share: the tool group id `app-plugin:<pluginId>` (`appPluginToolGroupId`), which is also the Marketplace activation subject of the plugin's tool switch; the listing route `PLUGIN_TOOLS_ROUTE` and its `PluginToolsListing`; the call path `pluginToolCallPath`; the `x-claxedo-agent` header (`PluginToolAgent`); and `PLUGIN_TOOL_RESULT_MAX_BYTES` (256 KiB). An `agent` caller's `identity.caller()` also names `sessionId`, `projectId`, `workspaceId` and `ownerDriven` where its credential carries them.

`pluginPlatform(env.PLATFORM, request)` is the same typed platform for a backend that routes for itself. A refused call throws `PluginPlatformError` with the platform's `status` and `code`.

| Member | Permission | Does |
| --- | --- | --- |
| `object(className, name, request)` | none | One of the plugin's own Durable Objects. Every object shares one `ctx.id`, so an object reads its own name from `x-claxedo-object-name`, never from `ctx.id`. |
| `active()` | none | Whether this backend is still the plugin's current activation. |
| `identity.caller()` | none | `{ orgId, origin, userId? }`: a `person` or an `agent` with their user id, a `link` or a `system` wake without one. |
| `projects.list()`, `projects.authorize(projectId, "read" \| "write")` | `projects.read` | As the caller, who must carry a user: a person or their agent. |
| `blobs.put(key, bytes, { contentType })`, `get`, `head`, `delete`, `list({ prefix, cursor })` | `blobs` | The plugin's own files in its organization. Keys match `PLUGIN_BLOB_LIMITS.keyPattern` with no empty, `.` or `..` segment. A blob is at most 16 MiB, and a plugin holds 1 GiB per organization by default. |
| `events.publish({ audience, projectId?, topic, data? })` | `events` | Tells the frontend of every member in the audience who has the plugin enabled: `caller`, a `project`'s readers, or the `org`. Data is at most 8 KiB of JSON, 10 events a second. |
| `schedule.at(name, at, payload?)`, `cancel(name)`, `list()` | `schedule` | Wakes at least 30 s ahead, at most 100, payload at most 4 KiB. Use these, not a Durable Object alarm. |
| `links.create({ path, expiresAt? })`, `links.revoke(token)` | `links` | A public link that reads `GET path` without signing in, as a `link` caller, until it expires or is revoked. |

## Releases

`@claxedo/plugin-api/release` is what the registry publishes and a hosted Worker installs: `PluginRelease` (`id`, `version`, the validated `manifest`, `app` and an optional `backend` as `{ sha256, size }` with the full 64-hex SHA-256, a forward-only `storage` generation, `tools` (each agent tool's `name`, `title`, `description`, `inputSchema` and `access`, present exactly when the manifest declares a tool group), `builtAt`) and `SignedPluginRelease` (`release`, a base64 Ed25519 `signature` over `canonicalJsonText(release)`, `keyId`). `verifyPluginRelease(signed, keys)` verifies the signature under the named key, then parses the release and checks that its manifest names the same id and version and declares a backend exactly when a backend bundle is present. `PLUGIN_REGISTRY_KEYS` pins the registry's public keys; it is empty until the registry's production key is issued. `PLUGIN_BUNDLE_MAX_BYTES` (10 MiB) bounds each bundle.

## CLI commands

`@claxedo/plugin-api/cli` declares `CliCommand` (`name`, `usage`, `run(args, context)`) and `CliCommandContext`, which the `claxedo` CLI hands a first-party plugin's command: the signed-in control plane's URL, its request path, the access token and the environment, so a command carries no credential handling of its own. The CLI composes them in `cli/src/plugin-commands.ts`; Documents contributes `claxedo documents`.

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
