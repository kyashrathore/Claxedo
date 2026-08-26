import { workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/server-transport"
import {
  WORKSPACE_DEFAULT_SANDBOX_DRIVER_PATH,
  WORKSPACE_SANDBOX_DRIVERS_PATH,
  workspaceSandboxDriverAuthPath,
} from "./workspace-control-paths"

function controlPlaneBaseUrl(baseUrl?: string) {
  return normalizeUrl(baseUrl) ?? getDefaultBaseUrl()
}

export function workspaceSandboxDriversUrl(input?: { baseUrl?: string }) {
  return new URL(WORKSPACE_SANDBOX_DRIVERS_PATH, controlPlaneBaseUrl(input?.baseUrl)).toString()
}

export function workspaceSandboxDriverAuthUrl(input: { baseUrl?: string; driverId: string }) {
  return new URL(workspaceSandboxDriverAuthPath(input.driverId), controlPlaneBaseUrl(input.baseUrl)).toString()
}

export function workspaceDefaultSandboxDriverUrl(input?: { baseUrl?: string }) {
  return new URL(WORKSPACE_DEFAULT_SANDBOX_DRIVER_PATH, controlPlaneBaseUrl(input?.baseUrl)).toString()
}

export function workspaceCreateUrl(input?: { baseUrl?: string }) {
  return new URL("/api/workspace/create", controlPlaneBaseUrl(input?.baseUrl)).toString()
}

export function workspaceResolveUrl(input: {
  baseUrl?: string
  scope?: string
  workspaceId?: string
  create?: boolean
}) {
  const baseUrl = controlPlaneBaseUrl(input.baseUrl)
  const path =
    centralTransportForServer(baseUrl) === "loopback" ? "/api/claxedo/workspace/resolve" : "/api/workspace/resolve"
  const url = new URL(path, baseUrl)
  const workspaceId = input.workspaceId ?? workspaceIdFromRef(input.scope)
  if (input.scope && !workspaceId) url.searchParams.set("directory", input.scope)
  if (workspaceId) url.searchParams.set("workspaceId", workspaceId)
  if (input.create) url.searchParams.set("create", "true")
  return url.toString()
}

export function controlWorkspaceUrl(input: { baseUrl?: string; workspaceId: string }) {
  return new URL(
    `/api/workspace/${encodeURIComponent(input.workspaceId)}`,
    controlPlaneBaseUrl(input.baseUrl),
  ).toString()
}

export function workspaceCheckpointsUrl(input: { baseUrl?: string; workspaceId: string }) {
  return new URL(
    `/api/workspace/${encodeURIComponent(input.workspaceId)}/checkpoints`,
    controlPlaneBaseUrl(input.baseUrl),
  ).toString()
}

export function workspaceCheckpointRestoreUrl(input: { baseUrl?: string; workspaceId: string; checkpointId: string }) {
  return new URL(
    `/api/workspace/${encodeURIComponent(input.workspaceId)}/checkpoints/${encodeURIComponent(input.checkpointId)}/restore`,
    controlPlaneBaseUrl(input.baseUrl),
  ).toString()
}

export function workspaceLifecycleUrl(input: {
  baseUrl?: string
  workspaceId: string
  operation: "stop" | "replace" | "cleanup" | "destroy"
}) {
  return new URL(
    `/api/workspace/${encodeURIComponent(input.workspaceId)}/lifecycle/${input.operation}`,
    controlPlaneBaseUrl(input.baseUrl),
  ).toString()
}

export type ControlSessionSuffix = `/${string}`

export function controlSessionListUrl(input: { baseUrl: string; workspaceId?: string; directory?: string }) {
  const url = new URL("/api/control/sessions", input.baseUrl)
  if (input.workspaceId) url.searchParams.set("workspaceId", input.workspaceId)
  if (input.directory) url.searchParams.set("directory", input.directory)
  return url
}

export function controlSessionUrl(input: {
  baseUrl: string
  sessionID: string
  suffix?: ControlSessionSuffix | ""
  workspaceId?: string
}) {
  const url = new URL(
    `/api/control/sessions/${encodeURIComponent(input.sessionID)}${input.suffix ?? ""}`,
    input.baseUrl,
  )
  if (input.workspaceId) url.searchParams.set("workspaceId", input.workspaceId)
  return url
}

export type ControlSessionNavigationListQuery = {
  scope: "global" | "project" | "workspace"
  projectId?: string
  workspaceId?: string
  directory?: string
  groupBy?: "none" | "project" | "workspace"
  archived?: "active" | "all" | "archived"
  status?: readonly string[]
  environment?: readonly string[]
  git?: readonly string[]
  search?: string
  limit: number
  cursor?: string
}

export function controlSessionNavigationListUrl(
  input: {
    baseUrl: string
  } & ControlSessionNavigationListQuery,
) {
  const url = new URL("/api/control/session-list", input.baseUrl)
  url.searchParams.set("scope", input.scope)
  url.searchParams.set("limit", String(input.limit))
  if (input.projectId) url.searchParams.set("projectId", input.projectId)
  if (input.workspaceId) url.searchParams.set("workspaceId", input.workspaceId)
  if (input.directory) url.searchParams.set("directory", input.directory)
  if (input.groupBy && input.groupBy !== "none") url.searchParams.set("groupBy", input.groupBy)
  if (input.archived && input.archived !== "active") url.searchParams.set("archived", input.archived)
  if (input.status?.length) url.searchParams.set("status", input.status.join(","))
  if (input.environment?.length) url.searchParams.set("environment", input.environment.join(","))
  if (input.git?.length) url.searchParams.set("git", input.git.join(","))
  if (input.search) url.searchParams.set("search", input.search)
  if (input.cursor) url.searchParams.set("cursor", input.cursor)
  return url
}

export function sessionNavigationListUrl(
  input: {
    baseUrl: string
  } & ControlSessionNavigationListQuery,
) {
  const url = controlSessionNavigationListUrl(input)
  if (centralTransportForServer(input.baseUrl) === "loopback") {
    url.pathname = "/api/claxedo/session-list"
  }
  return url
}

export function experimentalSandboxPath(scope: string) {
  const url = new URL("/api/experimental/sandbox", "http://claxedo.local")
  url.searchParams.set("directory", scope)
  return `${url.pathname}${url.search}`
}
