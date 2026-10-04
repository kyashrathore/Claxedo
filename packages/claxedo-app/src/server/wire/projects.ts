import { isRecord } from "@claxedo/helpers/guards"
import { unreachable } from "../../lib/machine"
import { ServerError } from "../errors"
import { projectId } from "../ids"
import type { MissingCheckout, Project, ProjectCommands, ProjectIcon, ProjectSource } from "../types"

type WireProject = {
  readonly id: string
  readonly name: string
  readonly env?: Record<string, string>
  readonly directory?: string | null
  readonly repoUrl?: string | null
  readonly icon?: { readonly override?: unknown; readonly color?: unknown }
  readonly commands?: { readonly start?: unknown }
  readonly available: boolean
  readonly missingCheckout?: { readonly directory?: unknown; readonly remote?: unknown }
  readonly created_at: number
  readonly updated_at: number
}

function isWireProject(value: unknown): value is WireProject {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.available === "boolean"
    && typeof value.created_at === "number" && typeof value.updated_at === "number"
}

function sourceOf(project: WireProject): ProjectSource | undefined {
  if (project.repoUrl) return { kind: "repository", url: project.repoUrl }
  if (project.directory) return { kind: "folder", path: project.directory }
  return undefined
}

function iconOf(project: WireProject): ProjectIcon | undefined {
  const override = typeof project.icon?.override === "string" ? project.icon.override : undefined
  const color = typeof project.icon?.color === "string" ? project.icon.color : undefined
  return override || color ? { ...(override ? { override } : {}), ...(color ? { color } : {}) } : undefined
}

function commandsOf(project: WireProject): ProjectCommands | undefined {
  return typeof project.commands?.start === "string" ? { start: project.commands.start } : undefined
}

function missingCheckoutOf(project: WireProject): MissingCheckout | undefined {
  const checkout = project.missingCheckout
  if (typeof checkout?.directory !== "string") return undefined
  return { directory: checkout.directory, ...(typeof checkout.remote === "string" ? { remote: checkout.remote } : {}) }
}

function projectFromWire(project: WireProject): Project {
  const source = sourceOf(project)
  const icon = iconOf(project)
  const commands = commandsOf(project)
  const missingCheckout = missingCheckoutOf(project)
  return {
    id: projectId(project.id),
    name: project.name,
    ...(source ? { source } : {}),
    ...(project.directory ? { directory: project.directory } : {}),
    ...(icon ? { icon } : {}),
    ...(commands ? { commands } : {}),
    available: project.available,
    ...(missingCheckout ? { missingCheckout } : {}),
    env: project.env ?? {},
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  }
}

export function projectSourceBody(source: ProjectSource) {
  switch (source.kind) {
    case "folder":
      return { kind: "directory", directory: source.path }
    case "repository":
      return { kind: "repository", repoUrl: source.url }
    case "connectedRepository":
      return { kind: "repository", connectionId: source.connectionId, repo: { fullName: source.fullName } }
    default:
      return unreachable(source)
  }
}

export function projectsFromWire(body: unknown): readonly Project[] {
  const rows = body && typeof body === "object" ? (body as { projects?: unknown }).projects : undefined
  if (!Array.isArray(rows)) throw new ServerError({ class: "internal", message: "The projects route answered without projects" })
  return rows.filter(isWireProject).map(projectFromWire)
}

export function oneProjectFromWire(body: unknown): Project {
  const project = body && typeof body === "object" ? (body as { project?: unknown }).project : undefined
  if (!isWireProject(project)) throw new ServerError({ class: "internal", message: "The projects route answered without a project" })
  return projectFromWire(project)
}
