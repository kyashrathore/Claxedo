import { getOwner, runWithOwner } from "solid-js"
import type { SurfaceChannel, SurfacePageDefinition } from "@claxedo/plugin-api"
import { FrameProtocolError, type Registration, type SurfaceDelivery, type SurfaceInvoke } from "./protocol"

export type SurfaceRoutes = {
  readonly attach: (channel: SurfaceChannel) => () => void
  readonly deliver: (delivery: SurfaceDelivery) => void
  readonly detachAll: () => void
}

export type InvokeSurface = (invoke: SurfaceInvoke) => Promise<unknown>

export function createSurfaceRoutes(report: (error: FrameProtocolError) => void): SurfaceRoutes {
  const channels = new Map<string, SurfaceChannel>()
  return {
    attach: (channel) => {
      channels.set(channel.surfaceId, channel)
      return () => channels.delete(channel.surfaceId)
    },
    deliver: (delivery) => {
      const channel = channels.get(delivery.surfaceId)
      if (!channel || !Array.isArray(delivery.messages)) return report(new FrameProtocolError("a surface message"))
      channel.send(...delivery.messages)
    },
    detachAll: () => channels.clear(),
  }
}

function failInOwner(owner: ReturnType<typeof getOwner>, error: unknown): void {
  runWithOwner(owner, () => {
    throw error
  })
}

export function frameSurfacePage(registration: Extract<Registration, { kind: "page" }>, routes: SurfaceRoutes, invoke: InvokeSurface): SurfacePageDefinition {
  return {
    id: registration.id,
    path: registration.path,
    title: registration.title,
    surface: (channel, props) => {
      const owner = getOwner()
      const { surfaceId } = channel
      const detach = routes.attach(channel)
      invoke({ method: "surface.open", pageId: registration.id, surfaceId, path: props.path, params: props.params }).catch((error: unknown) => failInOwner(owner, error))
      return {
        action: async (action) => {
          await invoke({ method: "surface.action", surfaceId, action })
        },
        dispose: () => {
          detach()
          invoke({ method: "surface.close", surfaceId }).catch((error: unknown) => console.error(`Plugin page ${registration.id} did not close surface ${surfaceId}`, error))
        },
      }
    },
  }
}
