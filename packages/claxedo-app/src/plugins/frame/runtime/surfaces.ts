import { createRoot } from "solid-js"
import type { PageDefinition, SurfaceMessage, SurfaceProgram } from "@claxedo/plugin-api"
import { unreachable } from "@/lib/machine"
import type { FrameToHost, SurfaceInvoke } from "../protocol"

export class FrameSurfaceError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "FrameSurfaceError"
  }
}

export type FrameSurfaces = { readonly answer: (invoke: SurfaceInvoke) => unknown }

type OpenSurface = { readonly program: SurfaceProgram; readonly close: () => void }

function openSurface(page: PageDefinition | undefined, invoke: Extract<SurfaceInvoke, { method: "surface.open" }>, send: (message: FrameToHost) => void): OpenSurface {
  if (!page || !("surface" in page)) throw new FrameSurfaceError(`No surface page ${invoke.pageId} is registered`)
  const { surfaceId } = invoke
  let open = true
  const channel = {
    surfaceId,
    send: (...messages: readonly SurfaceMessage[]) => {
      if (open) send({ type: "surface", surfaceId, messages })
    },
  }
  return createRoot((disposeRoot) => {
    const close = (program: SurfaceProgram) => {
      open = false
      try {
        program.dispose?.()
      } finally {
        disposeRoot()
      }
    }
    try {
      const program = page.surface(channel, { path: invoke.path, params: invoke.params }) ?? {}
      return { program, close: () => close(program) }
    } catch (error) {
      close({})
      throw error
    }
  })
}

export function createFrameSurfaces(pages: ReadonlyMap<string, PageDefinition>, send: (message: FrameToHost) => void): FrameSurfaces {
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
          opened.set(invoke.surfaceId, openSurface(pages.get(invoke.pageId), invoke, send))
          return undefined
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
