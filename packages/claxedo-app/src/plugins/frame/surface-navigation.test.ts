import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { PageDefinition, PluginApi, SettingsSectionDefinition, SurfaceChannel, SurfaceMessage, SurfaceProgram } from "@claxedo/plugin-api"
import { SURFACE_CATALOG_ID } from "@claxedo/plugin-api/surface"
import { openPluginSurface } from "../surface-page/controller"
import { createHostPort } from "./host-port"
import type { FrameMirror } from "./protocol"
import { createFrameApi, type FrameEntries } from "./runtime/api"
import { answerInvoke } from "./runtime/invokes"
import { createFrameLink } from "./runtime/link"
import { createFrameSurfaces } from "./runtime/surfaces"

const MIRROR: FrameMirror = { locale: "en", projects: [], currentProjectId: undefined, currentSession: undefined, tabs: [], statuses: {} }

type Registered = { readonly pages: Promise<PageDefinition>; readonly settings: Promise<SettingsSectionDefinition> }

function bridge(activate: (api: PluginApi) => void): Registered & { readonly dispose: () => void } {
  const channel = new MessageChannel()
  let page: (definition: PageDefinition) => void = () => undefined
  let section: (definition: SettingsSectionDefinition) => void = () => undefined
  const pages = new Promise<PageDefinition>((resolve) => (page = resolve))
  const settings = new Promise<SettingsSectionDefinition>((resolve) => (section = resolve))
  const hostApi = {
    pages: { register: (definition: PageDefinition) => (page(definition), () => undefined) },
    settings: { section: (definition: SettingsSectionDefinition) => (section(definition), () => undefined) },
  } as unknown as PluginApi
  const hostPort = createHostPort({ port: channel.port1, api: hostApi, mirror: () => MIRROR, control: { slots: () => undefined, activated: () => undefined, failed: (reason) => console.error(reason) } })
  const link = createFrameLink(channel.port2, MIRROR)
  const entries: FrameEntries = { pages: new Map(), settings: new Map(), overlays: new Map(), commands: new Map(), mentions: new Map() }
  const frameApi = createFrameApi({ link, context: { pluginId: "fixture", pluginVersion: "0.1.0", platform: "web", backend: false }, entries, dictionary: undefined, forward: true, signal: new AbortController().signal })
  const surfaces = createFrameSurfaces(entries, link.send)
  link.onInvoke((invoke) => answerInvoke(entries, surfaces, invoke))
  activate(frameApi)
  return { pages, settings, dispose: hostPort.dispose }
}

function applied(count: number) {
  const messages: SurfaceMessage[] = []
  let reached: () => void = () => undefined
  const done = new Promise<void>((resolve) => (reached = resolve))
  const apply = (message: SurfaceMessage) => {
    messages.push(message)
    if (messages.length >= count) reached()
  }
  return { messages, done, surface: { surfaceId: "surface-1", apply } }
}

const selected = (value: string): SurfaceMessage => ({ version: "v0.9", updateDataModel: { surfaceId: "surface-1", path: "/selected", value } })

function selectionProgram(channel: SurfaceChannel, itemId: string, opens: string[]): SurfaceProgram {
  opens.push(itemId)
  channel.send({ version: "v0.9", createSurface: { surfaceId: channel.surfaceId, catalogId: SURFACE_CATALOG_ID } }, selected(itemId))
  return { navigated: (props) => channel.send(selected(props.params.itemId ?? "none")) }
}

describe("surfaces in the web frame", () => {
  test("a param change reaches the program that is already open, so it keeps its state", async () => {
    const opens: string[] = []
    const { pages, dispose } = bridge((api) =>
      api.pages.register({ id: "items", path: "/items/:itemId?", title: "Items", tab: true, surface: (channel, props) => selectionProgram(channel, props.params.itemId ?? "none", opens) }),
    )
    const page = await pages
    if (!("surface" in page)) throw new Error("the frame registered a rendered page")
    expect(page.tab).toBe(true)
    const drawn = applied(3)
    const controller = createRoot(() => openPluginSurface({ surface: drawn.surface, label: "page items", open: (channel) => page.surface(channel, { path: page.path, params: {} }) }))
    controller.navigated({ path: page.path, params: { itemId: "item-2" } })
    await drawn.done
    expect(drawn.messages.slice(1)).toEqual([selected("none"), selected("item-2")])
    expect(opens).toEqual(["none"])
    expect(controller.state()).toEqual({ kind: "open" })
    dispose()
  })

  test("a surface settings section registers with its group and draws what its program sends", async () => {
    const { settings, dispose } = bridge((api) =>
      api.settings.section({ id: "presets", title: "Presets", group: "workspace", surface: (channel) => channel.send({ version: "v0.9", createSurface: { surfaceId: channel.surfaceId, catalogId: SURFACE_CATALOG_ID } }) }),
    )
    const section = await settings
    if (!("surface" in section)) throw new Error("the frame registered a rendered section")
    expect([section.id, section.group]).toEqual(["presets", "workspace"])
    const drawn = applied(1)
    createRoot(() => openPluginSurface({ surface: drawn.surface, label: "settings section presets", open: (channel) => section.surface(channel) }))
    await drawn.done
    expect(drawn.messages).toEqual([{ version: "v0.9", createSurface: { surfaceId: "surface-1", catalogId: SURFACE_CATALOG_ID } }])
    dispose()
  })
})
