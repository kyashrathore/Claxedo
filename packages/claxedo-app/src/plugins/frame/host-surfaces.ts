import { getOwner, runWithOwner } from "solid-js"
import type { SurfaceChannel, SurfacePageDefinition, SurfaceProgram, SurfaceSettingsSection } from "@claxedo/plugin-api"
import { FrameProtocolError, type Registration, type SurfaceDelivery, type SurfaceInvoke, type SurfaceTarget } from "./protocol"

export type SurfaceRoutes = {
  readonly attach: (channel: SurfaceChannel) => () => void
  readonly deliver: (delivery: SurfaceDelivery) => void
  readonly detachAll: () => void
}

export type InvokeSurface = (invoke: SurfaceInvoke) => Promise<unknown>

export type FrameSurfaceEndpoints = {
  readonly surfaces: SurfaceRoutes
  readonly invoke: InvokeSurface
  readonly refreshMirror: () => void
}

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

function frameSurfaceProgram(label: string, target: SurfaceTarget, endpoints: FrameSurfaceEndpoints, channel: SurfaceChannel): SurfaceProgram {
  const owner = getOwner()
  const { surfaceId } = channel
  const { invoke, refreshMirror } = endpoints
  const detach = endpoints.surfaces.attach(channel)
  refreshMirror()
  invoke({ method: "surface.open", surfaceId, target }).catch((error: unknown) => failInOwner(owner, error))
  return {
    action: async (action) => {
      await invoke({ method: "surface.action", surfaceId, action })
    },
    navigated: async (props) => {
      refreshMirror()
      await invoke({ method: "surface.navigated", surfaceId, path: props.path, params: props.params })
    },
    dispose: () => {
      detach()
      invoke({ method: "surface.close", surfaceId }).catch((error: unknown) => console.error(`Plugin ${label} did not close surface ${surfaceId}`, error))
    },
  }
}

export function frameSurfacePage(registration: Extract<Registration, { kind: "page" }>, endpoints: FrameSurfaceEndpoints): SurfacePageDefinition {
  const { id: pageId, path, title, tab, icon } = registration
  return {
    id: pageId,
    path,
    title,
    ...(tab ? { tab } : {}),
    ...(icon ? { icon } : {}),
    surface: (channel, props) => frameSurfaceProgram(`page ${pageId}`, { kind: "page", pageId, path: props.path, params: props.params }, endpoints, channel),
  }
}

export function frameSurfaceSettings(registration: Extract<Registration, { kind: "settings" }>, endpoints: FrameSurfaceEndpoints): SurfaceSettingsSection {
  const { id: sectionId, title, icon, order, group } = registration
  return {
    id: sectionId,
    title,
    ...(icon ? { icon } : {}),
    ...(order === undefined ? {} : { order }),
    ...(group ? { group } : {}),
    surface: (channel) => frameSurfaceProgram(`settings section ${sectionId}`, { kind: "settings", sectionId }, endpoints, channel),
  }
}
