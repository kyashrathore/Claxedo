import type { PluginApi, SessionAttachment, SessionRef, SessionStatus } from "@claxedo/plugin-api"
import { encodeAttachmentData } from "@claxedo/tasks"
import { uuid } from "@/lib/uuid"
import { sessionId, type Placement, type PromptAttachment } from "@/server"
import type { SessionRowView } from "@/session"
import { sessionPath } from "@/shell"
import { currentProjectId, PluginEntryError, type BindingScope } from "./services"

type Data = Pick<PluginApi, "sessions" | "projects" | "context">

const PLACEMENT_PREFERENCE: readonly Placement["kind"][] = ["folder", "worktree", "cloud"]

function promptAttachment(scope: BindingScope, attachment: SessionAttachment): PromptAttachment {
  const mime = attachment.mimeType
  if (mime.startsWith("image/")) return { kind: "image", dataUrl: `data:${mime};base64,${encodeAttachmentData(attachment.bytes)}`, name: attachment.name, mime }
  if (mime.startsWith("text/") || mime === "application/json") {
    return { kind: "text", text: new TextDecoder().decode(attachment.bytes), label: attachment.name }
  }
  throw new PluginEntryError(scope.manifest.id, `attachments of type ${mime} are not supported`)
}

function placementFor(scope: BindingScope, projectId: string): Placement {
  const placements = scope.services.server.placements.list().filter((placement) => placement.projectId === projectId)
  const preferred = PLACEMENT_PREFERENCE.flatMap((kind) => placements.filter((placement) => placement.kind === kind))[0]
  if (!preferred) throw new PluginEntryError(scope.manifest.id, `project ${projectId} has no placement to start a session in`)
  return preferred
}

function sessionRowOf(scope: BindingScope, ref: SessionRef): SessionRowView | undefined {
  const row = scope.services.sessions.list.view(sessionId(ref.sessionId))
  return row?.ref.placementId === ref.workspaceId ? row : undefined
}

export function sessionStatusOf(row: SessionRowView | undefined): SessionStatus {
  if (row?.waitingOnUser) return "waiting"
  switch (row?.status.kind) {
    case "working":
    case "retrying":
    case "recovering":
      return "running"
    case "failed":
      return "failed"
    default:
      return "idle"
  }
}

function sessionBindings(scope: BindingScope): PluginApi["sessions"] {
  const { sessions, routing } = scope.services
  return {
    create: async (input) => {
      const placement = placementFor(scope, input.projectId)
      const attachments = (input.attachments ?? []).map((attachment) => promptAttachment(scope, attachment))
      const ref = await sessions.list.create({ placementId: placement.id, title: input.title })
      await sessions.open(ref).send({ clientRequestId: uuid(), text: input.prompt, attachments })
      return { sessionId: ref.sessionId, workspaceId: ref.placementId }
    },
    status: (ref) => sessionStatusOf(sessionRowOf(scope, ref)),
    open: (ref) => {
      const row = sessionRowOf(scope, ref)
      if (!row) throw new PluginEntryError(scope.manifest.id, `session ${ref.sessionId} is not in the session list`)
      routing.navigate(sessionPath(row.ref))
    },
  }
}

export function dataBindings(scope: BindingScope): Data {
  const { services } = scope
  return {
    sessions: sessionBindings(scope),
    projects: {
      list: () => services.projects().map((project) => ({ id: project.id, name: project.name })),
      currentId: () => currentProjectId(services),
    },
    context: {
      pluginId: scope.manifest.id,
      pluginVersion: scope.manifest.version,
      platform: services.platform,
      get locale() {
        return services.i18n.locale()
      },
      currentProjectId: () => currentProjectId(services),
      currentSession: () => {
        const route = services.routing.route()
        if (route.kind !== "session") return undefined
        return { sessionId: route.sessionId, workspaceId: route.placementId }
      },
      signal: scope.signal,
    },
  }
}
