---
name: claxedo-plugin-authoring
description: "Create or change a Claxedo app plugin: a SolidJS package that adds pages, sidebar items, panes, settings sections, overlays, commands, mentions, themes or icon skins to the running Claxedo app, and goes live without a reload."
---

# Author Claxedo plugins

A Claxedo plugin is a small TypeScript package. Its `package.json` carries a `claxedo` block, and its app entry exports `definePlugin({ activate(api) })`. The running app picks up every build of a registered folder, so the loop is: scaffold, register once, edit, see it live.

## The loop

```sh
claxedo plugin new <name>            # scaffolds ./<name> with package.json, tsconfig.json and src/app.tsx
claxedo plugin add ./<name>          # registers the folder with the running daemon; the app loads it
claxedo plugin check ./<name>        # typechecks against @claxedo/plugin-api, then builds
claxedo plugin dev ./<name>          # watches, rebuilds on save and prints each build's hash or errors
```

`add` is done once per folder. After that the daemon watches the folder, rebuilds on every save, serves the build under an immutable URL and tells the app, which activates the new version and disposes the old one. A build that fails leaves the previous version running and reports the error in Settings → Plugins and in `claxedo plugin dev`.

Finish a task with `claxedo plugin check` passing. Do not add a build step, a bundler config or a dist folder to the plugin: the daemon builds it.

## The manifest

```json
{
  "name": "claxedo-plugin-notes",
  "version": "0.1.0",
  "type": "module",
  "claxedo": {
    "id": "notes",
    "name": "Notes",
    "version": "0.1.0",
    "app": "./src/app.tsx",
    "requires": [],
    "server": { "routes": [], "operations": [] }
  }
}
```

- `id`: lowercase letters, digits and dashes; never changes after the folder is added.
- `app`: the entry, relative to the package root.
- `requires`: capabilities the server must have: `tasks` (the Tasks routes), `documents` (the documents API). Leave it empty unless the plugin calls them.
- `server.routes`: Claxedo server route prefixes `api.server.fetch` may call, under `/api/claxedo/`.
- `server.operations`: control-plane operations `api.server.operation` may run, such as `documents.*`.

## What a plugin may import

`solid-js`, `solid-js/web`, `solid-js/store`, `@claxedo/plugin-api` and `@claxedo/app-v2/ui` are provided by the app at runtime and never bundled. Everything else bundles from the plugin's own `node_modules`. Use the app's kit from `@claxedo/app-v2/ui` so the plugin looks native; do not add a UI library.

## The API

`activate(api)` runs once per version inside a Solid root that belongs to the plugin. Every registration returns a disposer, and the host disposes everything when the plugin is switched off, replaced by a newer build or fails. Return a function from `activate` for any cleanup of your own.

| Primitive | Signature | Purpose |
| --- | --- | --- |
| `api.sidebar.item` | `({ id, label, pageId, icon?, order?, badge? }) => dispose` | A row in the main sidebar that opens a page |
| `api.pages.register` | `({ id, path, title, render(props) }) => dispose` | A page in the page tab, with its own path |
| `api.pages.open` | `(pageId, params?) => void` | Open a registered page |
| `api.panes.register` | `({ kind, title(state), render(props), restore: { parse, serialize } }) => dispose` | A pane kind in the workbench, restored across restarts through `restore` |
| `api.panes.open` | `(kind, state) => void` | Open a pane |
| `api.settings.section` | `({ id, title, icon?, order?, render() }) => dispose` | A section in the settings sidebar and page |
| `api.overlays.register` | `({ id, keybinding, render({ close }) }) => dispose` | A keyboard-invoked overlay |
| `api.overlays.open` / `close` | `(overlayId) => void` | Show or hide an overlay |
| `api.commands.register` | `({ id, title, keybinding?, category?, enabled?(ctx), run(ctx) }) => dispose` | A command in the palette, with an optional keybinding like `mod+shift+n` |
| `api.commands.run` | `(commandId) => Promise<void>` | Run any command |
| `api.mentions.register` | `({ id, label, search(query, ctx), insert(item) }) => dispose` | Items in the composer's `@` menu |
| `api.workbench.tabs` | `() => WorkbenchTab[]` | The open tabs with `status`, `active` and `index` |
| `api.workbench.activate` / `close` / `move` | `(tabId) / (tabId) / (tabId, index)` | Act on tabs |
| `api.workbench.onChanged` | `(listener) => dispose` | Follow tab changes |
| `api.themes.register` | `({ id, name, appearance, tokens }) => dispose` | A selectable theme |
| `api.icons.registerSkin` | `({ id, name, icons }) => dispose` | An icon skin |
| `api.sessions.create` | `({ projectId, prompt, title?, attachments? }) => Promise<SessionRef>` | Start a session with a first message |
| `api.sessions.status` | `(ref) => "idle" \| "running" \| "waiting" \| "failed"` | A session's status |
| `api.sessions.open` | `(ref) => void` | Show a session |
| `api.projects.list` | `() => ProjectSummary[]` | The user's projects |
| `api.projects.currentId` | `() => string \| undefined` | The current project's id |
| `api.server.fetch` | `(path, init?) => Promise<Response>` | An authenticated call to a route the manifest names |
| `api.server.operation` | `(name, input?) => Promise<Result>` | A control-plane operation the manifest names |
| `api.context` | `{ pluginId, pluginVersion, platform, locale, currentProjectId(), currentSession(), signal }` | Where the plugin runs; `signal` aborts when the plugin is disposed |
| `api.ui.toast` | `({ kind, title, description? }) => void` | A toast |
| `api.ui.confirm` | `({ title, description?, confirmLabel?, destructive? }) => Promise<boolean>` | A confirmation dialog |
| `api.i18n.t` | `(key, params?) => string` | A translated string |

`projects.list`, `projects.currentId`, `workbench.tabs`, `sessions.status`, `context.currentProjectId` and `context.currentSession` are Solid accessors: read them inside JSX, memos or effects and they track.

## Example 1: a page

```tsx
import { createSignal, For } from "solid-js"
import { definePlugin } from "@claxedo/plugin-api"
import { Button } from "@claxedo/app-v2/ui"

function NotesPage() {
  const [notes, setNotes] = createSignal<string[]>([])
  return (
    <section>
      <h1>Notes</h1>
      <Button onClick={() => setNotes([...notes(), `Note ${notes().length + 1}`])}>Add a note</Button>
      <ul>
        <For each={notes()}>{(note) => <li>{note}</li>}</For>
      </ul>
    </section>
  )
}

export default definePlugin({
  activate(api) {
    api.pages.register({ id: "notes", path: "/notes", title: "Notes", render: () => <NotesPage /> })
    api.sidebar.item({ id: "notes", label: "Notes", icon: "note", pageId: "notes" })
  },
})
```

## Example 2: a command and a sidebar item

```tsx
import { definePlugin } from "@claxedo/plugin-api"

export default definePlugin({
  activate(api) {
    api.pages.register({
      id: "standup",
      path: "/standup",
      title: "Standup",
      render: () => <p>Today's sessions: {api.workbench.tabs().length}</p>,
    })
    api.sidebar.item({ id: "standup", label: "Standup", pageId: "standup" })
    api.commands.register({
      id: "standup.start",
      title: "Start the standup session",
      keybinding: "mod+shift+s",
      enabled: () => api.projects.currentId() !== undefined,
      async run() {
        const projectId = api.projects.currentId()
        if (!projectId) return
        const ref = await api.sessions.create({ projectId, prompt: "Summarize what changed since yesterday." })
        api.sessions.open(ref)
        api.ui.toast({ kind: "success", title: "Standup session started" })
      },
    })
  },
})
```

## Rules the host enforces

- Every contribution renders inside the plugin's error boundary; a throwing render shows the error in place and never takes the app down.
- `activate` that throws moves the plugin to `failed` with the reason shown in Settings → Plugins; a newer build that fails to activate leaves the previous version running.
- Calls outside the manifest's `server.routes` and `server.operations` are refused by the host.
- On the web the plugin runs in a sandboxed iframe; on desktop it runs in the app's own JavaScript.
- Never poll: read accessors, subscribe with `workbench.onChanged`, and stop work when `api.context.signal` aborts.
- Use Claxedo names (`sessionId`, `projectId`), no `oc-` prefixes, and no comments in the code.
