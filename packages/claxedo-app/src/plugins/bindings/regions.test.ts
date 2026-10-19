import { describe, expect, mock, test } from "bun:test"
import { createSignal } from "solid-js"
import type { PageEntry, Registry, SettingsSection } from "@/shell"
import { createRegistrationSink } from "../registrations"
import type { BindingScope } from "./services"

const drawn: string[] = []
await mock.module("@/shell", () => ({
  fillPattern: (pattern: string) => pattern,
  sessionPath: (ref: { placementId: string; sessionId: string }) => `${ref.placementId}/${ref.sessionId}`,
  settingsPath: (section: string) => `/settings/${encodeURIComponent(section)}`,
}))
await mock.module("../boundary", () => ({ boundedView: (_name: string, view: unknown) => view }))
await mock.module("../surface-page/view", () => ({
  PluginSurfacePage: (props: { readonly page: { readonly id: string } }) => void drawn.push(`page ${props.page.id}`),
  PluginSurfaceSettings: (props: { readonly section: { readonly id: string } }) => void drawn.push(`settings ${props.section.id}`),
}))
const { PLUGIN_ICON, regionBindings } = await import("./regions")

function registry<Entry>(): Registry<Entry> {
  const [entries, setEntries] = createSignal<readonly Entry[]>([])
  return {
    list: entries,
    add: (entry) => {
      setEntries((current) => [...current, entry])
      return () => setEntries((current) => current.filter((candidate) => candidate !== entry))
    },
  }
}

function fixture() {
  const pages = registry<PageEntry>()
  const settingsSections = registry<SettingsSection>()
  const navigated: string[] = []
  const scope = {
    manifest: { id: "fixture", name: "Fixture", version: "0.1.0" },
    sink: createRegistrationSink("fixture"),
    services: { registries: { pages, settingsSections }, routing: { navigate: (path: string) => navigated.push(path) } },
  } as unknown as BindingScope
  return { api: regionBindings(scope), pages, settingsSections, navigated }
}

describe("plugin region bindings", () => {
  test("a surface page with tab and icon shares the page tab under its glyph; a rendered page keeps the main center", () => {
    const { api, pages } = fixture()
    api.pages.register({ id: "board", path: "/board/:itemId?", title: "Board", tab: true, icon: "checklist", surface: () => undefined })
    api.pages.register({ id: "notes", path: "/notes", title: "Notes", render: () => undefined })
    expect(pages.list().map(({ id, icon, tab }) => ({ id, icon, tab }))).toEqual([
      { id: "fixture/board", icon: "checklist", tab: true },
      { id: "fixture/notes", icon: PLUGIN_ICON, tab: undefined },
    ])
  })

  test("a surface settings section draws as a surface in its group, and settings.open reaches only the plugin's own sections", () => {
    const { api, settingsSections, navigated } = fixture()
    api.settings.section({ id: "presets", title: "Presets", group: "workspace", surface: () => undefined })
    api.settings.section({ id: "prefs", title: "Prefs", render: () => undefined })
    const [presets, prefs] = settingsSections.list()
    expect([presets?.id, presets?.group, prefs?.id, prefs?.group]).toEqual(["fixture/presets", "workspace", "fixture/prefs", "app"])
    presets?.view({})
    expect(drawn).toEqual(["settings presets"])
    api.settings.open("presets")
    expect(navigated).toEqual(["/settings/fixture%2Fpresets"])
    expect(() => api.settings.open("missing")).toThrow("no settings section missing is registered")
  })
})
