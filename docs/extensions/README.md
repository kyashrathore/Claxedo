# User extensions

Claxedo's UI is user-extendable on the local product (desktop and self-hosted
local server). An extension is a plain directory of JavaScript the user drops
into their data directory; Claxedo lists it over the loopback control plane,
imports it after boot settles, and gives it a container element to render
into. No build step, no framework requirement, no marketplace account.

## Install layout

```
~/.claxedo/extensions/
  hello-clock/
    claxedo-extension.json   # manifest (required)
    main.js                  # entry module named by the manifest
    ...                      # any other .js/.mjs/.css/.json/.svg/.png/.woff2 assets
```

(`CLAXEDO_DATA_DIR` relocates `~/.claxedo` as usual.)

## Manifest

`claxedo-extension.json`, validated server-side; invalid manifests are skipped
with a reason in the listing rather than failing the list:

```json
{
  "name": "hello-clock",
  "version": "1.0.0",
  "entry": "main.js",
  "apiVersion": 1,
  "displayName": "Hello Clock",
  "description": "A tiny example extension."
}
```

- `name` — `[a-z0-9][a-z0-9-]*`, and it must equal the directory name.
- `entry` — a relative `.js`/`.mjs` path inside the extension directory.
- `apiVersion` — must be `1`.

## Extension API v1

The entry module exports `activate(api)`. It runs once, after boot, in the
renderer:

```js
// main.js
export function activate(api) {
  api.registerView({
    id: "clock",            // becomes "hello-clock.clock"
    title: "Clock",         // shown in the command palette and the tab
    mount(container, context) {
      const el = document.createElement("div")
      el.textContent = new Date().toLocaleTimeString()
      const timer = setInterval(() => {
        el.textContent = new Date().toLocaleTimeString()
      }, 1000)
      container.append(el)
      return () => clearInterval(timer)   // dispose — runs when the tab unmounts
    },
  })
}
```

- `api.extension` — `{ name, version, baseUrl }` (frozen).
- `api.registerView({ id, title, mount })` — contributes a workbench view.
  `mount(container, context)` receives a live DOM element and
  `context.directory` (the pane's workspace directory, when it has one), and
  may return a dispose function. Render with anything — vanilla DOM, or a
  framework you bundle into your entry module.

Each registered view gets a **command palette** entry (category "Extensions").
Selecting it opens the view as a workbench tab — one tab per view, reopening
focuses it. Tabs survive reload: a restored tab shows a placeholder until the
extension finishes loading, then mounts live.

## Loading model and failure isolation

- Extensions load in an idle callback after boot settles — never on the boot
  critical path.
- Each extension activates in isolation: a throwing `activate` (or a missing
  `activate` export) is reported to the console, its partial view
  registrations are rolled back, and every other extension still loads.
- Kill switch: `localStorage["claxedo.user-extensions"] = "off"` disables
  loading entirely.

## Security posture

- Local product only. Hosted/signed deployments refuse the extension routes
  (`403`), and the renderer only asks over the loopback transport.
- The server serves files strictly from inside the extension's own directory
  (path traversal and out-of-tree symlinks are 404s) and only allowlisted
  file types.
- Extensions are the user's own code running in their own local app — the same
  trust level as anything else in `~/.claxedo`. Do not install extensions you
  don't trust.

## Example

`docs/extensions/example-hello-clock/` is a complete extension; copy it to
`~/.claxedo/extensions/hello-clock/` and restart (or reload) the app, then run
"Clock" from the command palette.
