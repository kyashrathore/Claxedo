import { createMemo, type Accessor } from "solid-js"
import type { PluginApi, PluginPlacement, PluginRequirement, SessionLink } from "@claxedo/plugin-api"
import { placementId as brandPlacementId, type Placement, type Project, type Server, type SessionStatus } from "@/server"

export type DataBindings = Pick<PluginApi, "sessions" | "projects" | "context">

export type DataBindingDeps = {
  readonly server: Server
  readonly navigate: (path: string) => void
  readonly pathname: Accessor<string>
  readonly projects: Accessor<readonly Project[]>
  readonly sessionStatus: (sessionId: string) => SessionStatus | undefined
  readonly platform: "desktop" | "web"
  readonly language: Accessor<string>
  readonly phone: Accessor<boolean>
}

export const NO_FEATURES: Readonly<Record<PluginRequirement, boolean>> = {
  tasks: false,
  documents: false,
  cloud: false,
  remoteAccess: false,
  marketplace: false,
  terminals: false,
  browser: false,
  sharing: false,
  livePlugins: false,
}

export function placementIdFromPath(pathname: string): string | undefined {
  const match = /^\/w\/([^/]+)/.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

export function sessionPath(link: SessionLink): string {
  return `/w/${encodeURIComponent(link.placementId)}/s/${encodeURIComponent(link.sessionId)}`
}

function toPluginPlacement(placement: Placement | undefined): PluginPlacement | undefined {
  if (!placement) return undefined
  return { id: placement.id, projectId: placement.projectId, kind: placement.kind, label: placement.label }
}

export function createDataBindings(deps: DataBindingDeps): DataBindings {
  const { server } = deps
  const currentPlacementId = createMemo(() => placementIdFromPath(deps.pathname()))
  const capabilities = server.capabilities
  return {
    sessions: {
      create: async (input) => {
        const row = await server.sessions.create({
          placementId: brandPlacementId(input.placementId),
          harness: input.harness,
          title: input.title,
        })
        await server.sessions.prompt(row.ref, {
          clientRequestId: crypto.randomUUID(),
          text: input.text,
          attachments: input.attachments ?? [],
        })
        return { placementId: row.ref.placementId, sessionId: row.ref.sessionId }
      },
      status: (link) => () => deps.sessionStatus(link.sessionId)?.kind,
      open: (link) => deps.navigate(sessionPath(link)),
    },
    projects: {
      list: createMemo(() => deps.projects().map((project) => ({ id: project.id, name: project.name }))),
      currentId: createMemo(() => {
        const id = currentPlacementId()
        return id === undefined ? undefined : server.placements.byId(brandPlacementId(id))?.projectId
      }),
      currentPlacementId,
      placement: (id) => toPluginPlacement(server.placements.byId(brandPlacementId(id))),
    },
    context: {
      platform: deps.platform,
      features: () => capabilities()?.features ?? NO_FEATURES,
      signedIn: () => capabilities()?.signedIn ?? false,
      user: () => {
        const principal = capabilities()?.principal
        return principal?.kind === "user" ? { id: principal.userId, name: principal.name } : undefined
      },
      phone: deps.phone,
      language: deps.language,
    },
  }
}
