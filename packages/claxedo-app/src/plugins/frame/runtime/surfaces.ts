import { createRoot } from "solid-js"
import type { SurfaceChannel, SurfaceMessage, SurfaceProgram } from "@claxedo/plugin-api"
import { unreachable } from "@/lib/machine"
import type { FrameToHost, SurfaceInvoke, SurfaceTarget } from "../protocol"
import type { FrameEntries } from "./api"

export class FrameSurfaceError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "FrameSurfaceError"
  }
}

export type FrameSurfaces = { readonly answer: (invoke: SurfaceInvoke) => unknown }

type OpenSurface = { readonly program: SurfaceProgram; readonly close: () => void }

type SurfaceEntries = Pick<FrameEntries, "pages" | "settings">

function programOpener(entries: SurfaceEntries, target: SurfaceTarget): (channel: SurfaceChannel) => SurfaceProgram | void {
  if (target.kind === "page") {
    const page = entries.pages.get(target.pageId)
    if (!page || !("surface" in page)) throw new FrameSurfaceError(`No surface page ${target.pageId} is registered`)
    return (channel) => page.surface(channel, { path: target.path, params: target.params })
  }
  const section = entries.settings.get(target.sectionId)
  if (!section || !("surface" in section)) throw new FrameSurfaceError(`No surface settings section ${target.sectionId} is registered`)
  return (channel) => section.surface(channel)
}

function openSurface(entries: SurfaceEntries, invoke: Extract<SurfaceInvoke, { method: "surface.open" }>, send: (message: FrameToHost) => void): OpenSurface {
  const open = programOpener(entries, invoke.target)
  const { surfaceId } = invoke
  let delivering = true
  const channel = {
    surfaceId,
    send: (...messages: readonly SurfaceMessage[]) => {
      if (delivering) send({ type: "surface", surfaceId, messages })
    },
  }
  return createRoot((disposeRoot) => {
    const close = (program: SurfaceProgram) => {
      delivering = false
      try {
        program.dispose?.()
      } finally {
        disposeRoot()
      }
    }
    try {
      const program = open(channel) ?? {}
      return { program, close: () => close(program) }
    } catch (error) {
      close({})
      throw error
    }
  })
}

export function createFrameSurfaces(entries: SurfaceEntries, send: (message: FrameToHost) => void): FrameSurfaces {
  const opened = new Map<string, OpenSurface>()
  const surfaceOf = (surfaceId: string) => {
    const surface = opened.get(surfaceId)
    if (!surface) throw new FrameSurfaceError(`No surface ${surfaceId} is open`)
    return surface
  }
  return {
    answer: async (invoke) => {
      switch (invoke.method) {
        case "surface.open":
          if (opened.has(invoke.surfaceId)) throw new FrameSurfaceError(`The surface ${invoke.surfaceId} is already open`)
          opened.set(invoke.surfaceId, openSurface(entries, invoke, send))
          return undefined
        case "surface.navigated":
          return surfaceOf(invoke.surfaceId).program.navigated?.({ path: invoke.path, params: invoke.params })
        case "surface.action":
          return surfaceOf(invoke.surfaceId).program.action?.(invoke.action)
        case "surface.close": {
          const surface = surfaceOf(invoke.surfaceId)
          opened.delete(invoke.surfaceId)
          return surface.close()
        }
        default:
          return unreachable(invoke)
      }
    },
  }
}
