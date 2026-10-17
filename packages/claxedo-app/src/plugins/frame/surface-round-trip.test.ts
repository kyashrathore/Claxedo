import { describe, expect, mock, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import type { PageDefinition, PluginApi, SurfaceMessage, SurfacePageDefinition } from "@claxedo/plugin-api"
import { SURFACE_CATALOG_ID } from "@claxedo/plugin-api/surface"
import { openSurfacePage, type SurfacePageController } from "../surface-page/controller"
import { createHostPort } from "./host-port"
import { FrameCallError } from "./pending-calls"
import type { FrameMirror } from "./protocol"
import { createFrameApi, type FrameEntries } from "./runtime/api"
import { answerInvoke } from "./runtime/invokes"
import { createFrameLink } from "./runtime/link"
import { createFrameSurfaces } from "./runtime/surfaces"

await mock.module("@/surface/view/surface-view", () => ({ SurfaceView: () => undefined }))
const { createSurface, SurfaceMessageError } = await import("@/surface")

const MIRROR: FrameMirror = { locale: "en", projects: [], currentProjectId: undefined, currentSession: undefined, tabs: [], statuses: {} }

type Recorder<Entry> = { readonly entries: Entry[]; readonly add: (entry: Entry) => void; readonly reached: (count: number) => Promise<void> }

function recorder<Entry>(): Recorder<Entry> {
  const entries: Entry[] = []
  const waiters: { readonly count: number; readonly resolve: () => void }[] = []
  return {
    entries,
    add: (entry) => {
      entries.push(entry)
      for (const waiter of waiters) if (waiter.count <= entries.length) waiter.resolve()
    },
    reached: (count) => new Promise<void>((resolve) => (count <= entries.length ? resolve() : waiters.push({ count, resolve }))),
  }
}

function failureOf(controller: SurfacePageController): Promise<Error> {
  return new Promise((resolve) =>
    createRoot(() =>
      createComputed(() => {
        const state = controller.state()
        if (state.kind === "failed") resolve(state.error)
      }),
    ),
  )
}

function hostSide(port: MessagePort) {
  const failures: string[] = []
  let announce: (page: PageDefinition) => void = () => undefined
  const registered = new Promise<PageDefinition>((resolve) => (announce = resolve))
  const api = { pages: { register: (page: PageDefinition) => (announce(page), () => undefined) } } as unknown as PluginApi
  const link = createHostPort({ port, api, control: { slots: () => undefined, activated: () => undefined, failed: (reason) => failures.push(reason) } })
  return { registered, failures, link }
}

function frameSide(port: MessagePort, page: SurfacePageDefinition) {
  const link = createFrameLink(port, MIRROR)
  const entries: FrameEntries = { pages: new Map(), settings: new Map(), overlays: new Map(), commands: new Map(), mentions: new Map() }
  const api = createFrameApi({ link, context: { pluginId: "fixture", pluginVersion: "0.1.0", platform: "web" }, entries, dictionary: undefined, forward: true, signal: new AbortController().signal })
  const surfaces = createFrameSurfaces(entries.pages, link.send)
  link.onInvoke((invoke) => answerInvoke(entries, surfaces, invoke))
  api.pages.register(page)
}

function itemsPage(log: Recorder<string>): SurfacePageDefinition {
  return {
    id: "items",
    path: "/items",
    title: "Items",
    surface: (channel, props) => {
      const { surfaceId } = channel
      const first = props.params.first ?? "none"
      if (first === "boom") throw new Error(`No items for ${first}`)
      const items = [first]
      channel.send({ version: "v0.9", createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } }, { version: "v0.9", updateDataModel: { surfaceId, path: "/items", value: items } })
      return {
        action: (action) => {
          log.add(`action ${action.name}`)
          if (action.name === "break") return channel.send({ version: "v0.9", updateDataModel: { surfaceId: 7 } } as unknown as SurfaceMessage)
          items.push(`item ${items.length + 1}`)
          channel.send({ version: "v0.9", updateDataModel: { surfaceId, path: "/items", value: items } })
        },
        dispose: () => log.add("disposed"),
      }
    },
  }
}

async function openOverPort(first = "alpha") {
  const log = recorder<string>()
  const applied = recorder<SurfaceMessage>()
  const channel = new MessageChannel()
  const host = hostSide(channel.port1)
  frameSide(channel.port2, itemsPage(log))
  const page = await host.registered
  if (!("surface" in page)) throw new Error("the frame registered a rendered page")
  const drawn = createSurface("surface-1")
  const apply = (message: SurfaceMessage) => {
    drawn.apply(message)
    applied.add(message)
  }
  const controller = createRoot(() => openSurfacePage({ surface: { surfaceId: "surface-1", apply }, page, props: { path: "/items", params: { first } } }))
  return { ...host, log, applied, controller }
}

const action = (name: string) => ({ name, surfaceId: "surface-1", sourceComponentId: "add", timestamp: "2026-10-17T00:00:00Z", context: {} })
const items = (value: readonly string[]): SurfaceMessage => ({ version: "v0.9", updateDataModel: { surfaceId: "surface-1", path: "/items", value: [...value] } })

describe("a surface page in the web frame", () => {
  test("opens in the frame, draws what it sends, answers an action and closes", async () => {
    const { applied, controller, failures, link, log } = await openOverPort()
    await applied.reached(2)
    expect(applied.entries[1]).toEqual(items(["alpha"]))
    controller.action(action("add"))
    await applied.reached(3)
    expect(applied.entries[2]).toEqual(items(["alpha", "item 2"]))
    controller.close()
    await log.reached(2)
    expect(log.entries).toEqual(["action add", "disposed"])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(failures).toEqual([])
    link.dispose()
  })

  test("the host drops a message that is not A2UI and fails the page", async () => {
    const { applied, controller, link } = await openOverPort()
    await applied.reached(2)
    controller.action(action("break"))
    expect(await failureOf(controller)).toBeInstanceOf(SurfaceMessageError)
    expect(applied.entries).toHaveLength(2)
    link.dispose()
  })

  test("a program that throws while opening in the frame fails the page on the host", async () => {
    const { applied, controller, link } = await openOverPort("boom")
    const failure = await failureOf(controller)
    expect(failure).toBeInstanceOf(FrameCallError)
    expect(failure.message).toBe("No items for boom")
    expect(applied.entries).toEqual([])
    link.dispose()
  })
})
