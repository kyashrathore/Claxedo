import fs from "node:fs/promises"
import path from "node:path"
import { writeLivePlugin, type LivePluginFolder } from "./live-plugins"

export const FIXTURE_ROUTES = ["/api/claxedo/projects"]

export type FixtureVersion = { readonly label: string; readonly routes?: readonly string[] }

export function fixturePluginSource(label: string) {
  return `import { createSignal, For } from "solid-js"
import { definePlugin, type PluginApi } from "@claxedo/plugin-api"
import { useTheme } from "@claxedo/app/ui"

export const dictionary = {
  en: { "fixture.greeting": "Hello from the fixture on {{platform}}", "fixture.settingsBody": "Fixture settings body" },
}

type Note = { readonly text: string }

function Home(props: { readonly api: PluginApi; readonly hostTheme?: () => string }) {
  const api = props.api
  const [results, setResults] = createSignal<string[]>([])
  const add = (line: string) => setResults((lines) => [...lines, line])
  const projectId = () => api.projects.currentId() ?? api.projects.list()[0]?.id ?? ""
  const createDocument = async () => {
    await api.server.operation("documents.create", { project_id: projectId(), display_name: "Fixture page", markdown: "# Fixture" })
    const listed = await api.server.operation<readonly unknown[]>("documents.list", { project_id: projectId() })
    add("documents " + listed.length)
  }
  const probeIsolation = () => {
    const attempt = (name: string, read: () => unknown) => {
      try {
        read()
        add(name + " readable")
      } catch {
        add(name + " blocked")
      }
    }
    attempt("storage", () => localStorage.length)
    attempt("app document", () => window.parent.document.title)
  }
  const startSession = async () => {
    const ref = await api.sessions.create({ projectId: projectId(), prompt: "Hello from the fixture", title: "Fixture session" })
    add("session " + api.sessions.status(ref))
    api.sessions.open(ref)
  }
  return (
    <section aria-label="Fixture home">
      <h2>{${JSON.stringify(label)}}</h2>
      <p>{api.i18n.t("fixture.greeting", { platform: api.context.platform })}</p>
      {props.hostTheme && <p>Host theme: {props.hostTheme()}</p>}
      <p>Projects: {api.projects.list().map((project) => project.name).join(", ")}</p>
      <p>Open tabs: {api.workbench.tabs().length > 0 ? "some" : "none"}</p>
      <button type="button" onClick={async () => add("fetch " + (await api.server.fetch("/api/claxedo/projects")).status)}>Fetch projects</button>
      <button type="button" onClick={() => void createDocument()}>Create a document</button>
      <button type="button" onClick={() => api.ui.toast({ kind: "success", title: "Fixture toast" })}>Show a toast</button>
      <button type="button" onClick={async () => add("confirmed " + (await api.ui.confirm({ title: "Fixture confirm?", confirmLabel: "Yes, confirm" })))}>Ask to confirm</button>
      <button type="button" onClick={() => void startSession()}>Start a session</button>
      <button type="button" onClick={() => api.overlays.open("finder")}>Open the overlay</button>
      <button type="button" onClick={probeIsolation}>Probe isolation</button>
      <ul aria-label="Fixture results"><For each={results()}>{(line) => <li>{line}</li>}</For></ul>
    </section>
  )
}

export default definePlugin({
  activate(api) {
    const theme = api.context.platform === "desktop" ? useTheme() : undefined
    api.pages.register({ id: "home", path: "/fixture", title: "Fixture", render: () => <Home api={api} hostTheme={theme?.themeId} /> })
    api.sidebar.item({ id: "home", label: "Fixture", pageId: "home" })
    api.settings.section({ id: "prefs", title: "Fixture settings", render: () => <p>{api.i18n.t("fixture.settingsBody")}</p> })
    api.overlays.register({
      id: "finder",
      keybinding: "mod+shift+u",
      render: (props) => (
        <div>
          <p>Fixture overlay</p>
          <button type="button" onClick={() => props.close()}>Close the fixture overlay</button>
        </div>
      ),
    })
    api.commands.register({ id: "hello", title: "Fixture: say hello", run: () => api.ui.toast({ kind: "info", title: "Fixture command ran" }) })
    api.mentions.register({
      id: "notes",
      label: "Fixture notes",
      search: (query) => [{ id: "one", label: "Fixture note one" }].filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
      insert: () => ({ text: "fixture-note-one" }),
    })
    for (const appearance of ["light", "dark"] as const) {
      api.themes.register({ id: "fixture", name: "Fixture theme", appearance, tokens: { "fixture-accent": "rgb(1, 2, 3)" } })
    }
    if (api.context.platform !== "desktop") return
    api.panes.register<Note>({
      kind: "notes",
      title: () => "Fixture pane",
      render: (props) => <p>Fixture pane: {props.state.text}</p>,
      restore: { parse: (raw) => (typeof raw === "object" && raw !== null && typeof (raw as Note).text === "string" ? (raw as Note) : undefined), serialize: (state) => state },
    })
    api.commands.register({ id: "pane", title: "Fixture: open a pane", run: () => api.panes.open<Note>("notes", { text: "Pane state" }) })
    api.icons.registerSkin({
      id: "fixture",
      name: "Fixture icons",
      icons: { page: () => <svg viewBox="0 0 20 20" width="16" height="16"><rect width="20" height="20" fill="currentColor" /></svg> },
    })
  },
})
`
}

export function fixtureFolder(version: FixtureVersion): LivePluginFolder {
  return { id: "fixture", name: "Fixture", routes: version.routes ?? FIXTURE_ROUTES, operations: ["documents.*"], requires: ["documents"], app: fixturePluginSource(version.label) }
}

export async function writeFixturePlugin(root: string, version: FixtureVersion) {
  return writeLivePlugin(path.join(root, "plugins", "fixture"), fixtureFolder(version))
}

export async function breakFixturePlugin(directory: string) {
  await fs.writeFile(path.join(directory, "src", "app.tsx"), "export default definePlugin({ activate( {} })\n")
}
