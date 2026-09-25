# App plugins

An **app plugin** changes this app: it adds sidebar items, pages, panes, settings sections, overlays, commands, `@` mentions, themes and icon skins, and calls the app's own server as the user. It runs in the app, never on the server or in an agent. An **agent plugin** (the Marketplace, `src/marketplace/`) changes what an agent can do: it installs skills and MCP tools into agent sessions and runs where the agent runs. The two share nothing but the word; every user-visible string here says "App plugins".

The plugin host. It runs the first-party plugins that `bundled.ts` lists from `plugins/` and the user's live plugins from the daemon, and it is the only code that knows a plugin exists. The contract is `@claxedo/plugin-api` (`packages/claxedo-plugin-api`); this folder implements it over the shell's registries.

## Owned concepts

- **Plugin build** (`model.ts`): a manifest, its origin (`bundled`, or `live` with the daemon's bundle hash), the `definePlugin` definition and an optional dictionary. A build's identity is the hash for a live plugin and the manifest version for a bundled one, so every save of a live plugin is a new build.
- **Activation** (`activation.ts`): `activate(api)` runs inside a Solid root that belongs to the plugin, under `catchError`. Every registration goes through the plugin's `RegistrationSink` (`registrations.ts`), and disposing the root disposes every entry, aborts `api.context.signal` and runs the cleanup `activate` returned. A sink refuses registrations after its plugin is disposed.
- **Bindings** (`bindings/`): the `PluginApi` for one build. Entry ids are `<pluginId>/<id>`; theme and icon skin ids stay as given because the theme id is what `data-theme` names, and a taken id is refused. Every page, pane, settings section and overlay view renders inside the plugin's error boundary (`boundary.tsx`). `server.fetch` accepts only same-server paths under a route the manifest names, and `server.operation` only operations it names; both are mistake catchers, not a sandbox. Plugin-facing reads that reach app hooks (a workbench tab's title) run under the plugin host's owner (`HostServices.owner`), because activations, the frame's boot and its mirror run outside the component tree. A theme's tokens are CSS custom properties without the leading `--`; the shell registers the theme with the kit (`shell/view/registered-appearance.tsx`) and a skin draws its icons while the theme of the same id is selected.
- **Choices** (`preferences.ts`): per principal scope, through `persistedSignal`: which plugins are switched off (on by default), and each live plugin's approval. Safe mode (`?safe-mode` on the app URL) keeps every live plugin off for that load.
- **Approval** (`approval.ts`): the user approves a live plugin's manifest, not its id. An approval records the access the manifest declared (server routes, operations, `requires`), the build hash and when. `approvalCheck` compares it with the running build: `unapproved`, `accessChanged` (the declared access differs, with what was added and removed), `codeChanged` (same access, new build, with its build time) or `approved`. Only `approved` and `codeChanged` run; `accessChanged` stops the plugin until the user approves again. `CODE_CHANGE_NEEDS_APPROVAL` is the one line that makes every new build ask. An approval names the build the user was shown, so a build that changed while the dialog was open is not approved by it.
- **Requirements**: `requires` names plugin capabilities (`tasks`, `documents`). `documents` is the bootstrap declaration's; `tasks` is read from the server (`queries.tasks.availability()`) only while some plugin requires it. The host re-checks them whenever an answer changes and activates or disposes to match.
- **Host** (`host.ts`, `lifecycle.ts`): one lifecycle per plugin, wanted when switched on, its requirements are met and, for a live plugin, it is confirmed and safe mode is off. A new build activates beside the running one and replaces it only once it activated. A build that is still starting is not started again when a preference or capability signal changes (two activations of one build shared one dictionary, and the first one's disposal removed it).
- **Settings → App plugins** (`view/`, section `app-plugins`): the warning for this platform (below), then every plugin with its origin, version, state and why it is not running; on and off; its manifest in readable form (name, id, version, folder with a copy action, routes, operations, requires, build hash, last build); and remove for a live plugin, after a confirmation. The approval dialog shows the same warning and manifest, and what changed when the access did.

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

- **Only the machine's owner.** The daemon answers the list, the bundles, add and remove only to the machine's owner (unsigned, the loopback gate; signed, `authorizeMachineOwner`), and `plugins.changed` reaches no signed subscriber. Every request carries the viewer's own credentials through the adapter. A refused list (`auth` class) is `notOwner` (`live/list-state.ts`): nothing is listed, activated or asked, and Settings says the machine's app plugins belong to its owner. Approvals and switches are kept per principal scope.
- The daemon's list (`server.queries.livePlugins.list()`, read only when the server reports `features.livePlugins`, re-read on `pluginsChanged`) is reconciled with the host: a new hash loads a new build, a removed row drops the plugin, and a failed daemon build keeps the served hash and shows `lastError`.
- A live bundle may export `dictionary` (`{ en: { key: text }, …locales }`, `dictionary.ts`): on the desktop it joins the app's dictionaries while the plugin is on; in the web frame `i18n.t` looks it up by the mirrored locale. A malformed one fails the load. Keys should carry the plugin's id: the app's own keys win a collision.
- A live build's manifest is the one the daemon built it from (the row's `manifest`); a `manifest` the bundle declares in code is not consulted beyond its id. The hash covers the manifest, so a manifest change alone is a new build.
- A load that fails becomes a build whose `activate` throws, so the machine keeps the running build and shows why. A plugin whose first build failed shows the daemon's error.
- When a live build needs approval, the host asks once per build; the answer is kept per principal. Settings asks again when the switch is turned on.
- **Desktop:** the bundle text is fetched through the adapter (the bundle route needs auth), imported from a Blob URL, and runs in the app's realm against `globalThis.__claxedoPluginRuntime` (`live/runtime.ts`).
- **Web:** the bundle never runs in the app's realm. `frame/` runs it in a sandboxed iframe (`sandbox="allow-scripts"`, never same-origin), so it has an opaque origin and cannot read the app's storage or DOM.

## The web frame (`frame/`)

- One hidden control frame per live plugin runs `activate` and forwards its registrations as plain descriptors over a `MessagePort` (`protocol.ts`). The host registers them through the same `PluginApi` a desktop plugin gets, so manifest limits and error boundaries apply unchanged.
- A page, settings section or overlay renders in its own slot frame, which activates the plugin again and renders only that target.
- Plugin functions stay in the frame: commands and mention searches are invoked over the port. Host calls (`server.fetch`, `sessions.create`, `ui.confirm`, …) are answered by the host. Synchronous accessors (projects, tabs, statuses, locale, current session) read a mirror the host pushes on change.
- The frame runtime is `frame/runtime/index.ts`, bundled on its own through Vite's worker build so it has no imports, fetched same-origin by the host, and imported from a Blob URL by the frame's bootstrap. The frame gets the app's stylesheets and theme attributes, so the kit looks native. Panes and icon skins are not available in the frame; the kit's sprite icons cannot load there.
- The Vite dev server serves the frame runtime unbundled, so web live plugins need a built app.

## Trust and warnings

- **Desktop:** an app plugin runs in the app's realm, unsandboxed, with the app's full access on this computer: what the user sees, the user's server, every desktop bridge, and links out through the user's browser or the Browser tab. The owner accepted that residual (DECISIONS, "desktop app plugins run in-app"). The warning (`plugins.warning.desktop`) says so and asks the user to turn on only app plugins they trust.
- **Web:** an app plugin runs in a sandboxed frame and reaches the server only through the host's manifest-checked calls; the warning (`plugins.warning.web`) says so.
- Settings and the approval dialog show the warning for `PluginsContext.platform`.
- **Network lock.** The app's Content-Security-Policy names its own server's exact origin (and, hosted, the relay origins given at build), never a wildcard host or port, and allows no other connection, frame or form target, and no other image but an `https:` one, which the transcript shows as v1 does (DECISIONS, Owner 2026-09-25 22:40): the build's `<meta>` on the web (`vite.content-security-policy.ts`), a header main stamps on the desktop renderer's documents (`claxedo-desktop/src/main/renderer-content-security.ts`); both come from `content-security-policy.ts`. The web frame's own policy (`src/plugins/frame/document.ts`) can only tighten what it inherits: `connect-src 'none'`, `media-src 'none'` and `img-src data: blob:`, so a web plugin loads no outside image, `https:` included, and because a frame's own navigation is checked against its parent's policy, the app frames only its own origin. On the desktop, `will-navigate` and `window.open` refuse every URL that is not the app document; a link the user clicks leaves through the preload's `openLink`. Flow 37 proves it on both. What the policy cannot stop: WebRTC (Chromium enforces no CSP directive for it), so a plugin can reach a STUN or TURN server of its choosing, and on the desktop the unsandboxed residual in the DECISIONS entry.

## Server access

`api.ts` is the host's only way to the server: `server.request` for a plugin's `server.fetch` (after the manifest check), the adapter's live plugin list, bundle and removal. `server.operation` goes to the adapter's `operation`, which sends the `documents.*` operations to the connected server's `/documents` routes (the daemon's unsigned, the control plane's when signed on the web), as today's app does without the account bridge. The signed desktop, where today's app runs them through the account bridge in main, is not served: v2 has no account layer yet. A plugin's requests carry the viewing user's credentials and nothing else, and the server applies that user's access.

## Flows

18 Tasks, 19 Pages, 20 on and off, 28 compact tabs, 29 Codex theme, 34 live plugin on desktop, 35 live plugin on the web.
