import { harnessSelectionQuery, type HarnessSelection } from "@/platform/identity/harness-selection"

type HarnessDirectory = string
type HarnessConfigResource = "harness" | "harness/options"
type HarnessSessionResource = "session" | "messages" | "todo" | "capabilities" | "config"

function harnessConfigPath(input: {
  resource?: HarnessConfigResource
  directory?: HarnessDirectory
  /** The workspace's identity; `directory` alone is only what a client shows for it. */
  workspaceId?: string
  sessionId?: string
  selection?: HarnessSelection
}) {
  const url = new URL(`/api/claxedo/agent-config/${input.resource ?? "harness"}`, "http://claxedo.local")
  if (input.directory) url.searchParams.set("directory", input.directory)
  if (input.workspaceId) url.searchParams.set("workspaceId", input.workspaceId)
  if (input.sessionId && input.sessionId !== "new") url.searchParams.set("sessionId", input.sessionId)
  appendSelection(url, input.selection)
  return `${url.pathname}${url.search}`
}

export function harnessConfigUrl(input: Parameters<typeof harnessConfigPath>[0] & { serverUrl: string }) {
  return new URL(harnessConfigPath(input), input.serverUrl).toString()
}

function sessionResourcePath(input: {
  sessionID: string
  directory: HarnessDirectory
  resource?: HarnessSessionResource
}) {
  const suffix = (() => {
    if (!input.resource || input.resource === "session") return ""
    if (input.resource === "messages") return "/message"
    return `/${input.resource}`
  })()
  const url = new URL(`/session/${encodeURIComponent(input.sessionID)}${suffix}`, "http://claxedo.local")
  url.searchParams.set("directory", input.directory)
  return `${url.pathname}${url.search}`
}

export function sessionResourceUrl(input: Parameters<typeof sessionResourcePath>[0] & { serverUrl: string }) {
  return new URL(sessionResourcePath(input), input.serverUrl).toString()
}

export function workspaceRuntimeAgentConfigPath(input: {
  resource: "api/wr/harness-config-options"
  directory: HarnessDirectory
  selection?: HarnessSelection
  sessionId?: string
}) {
  const url = new URL(input.sessionId && input.sessionId !== "new" ? `/session/${encodeURIComponent(input.sessionId)}/config-options` : `/${input.resource}`, "http://claxedo.local")
  url.searchParams.set("directory", input.directory)
  appendSelection(url, input.selection)
  return `${url.pathname}${url.search}`
}

function appendSelection(url: URL, selection?: HarnessSelection) {
  if (!selection) return
  const query = harnessSelectionQuery(selection)
  if ("nativeHarness" in query) url.searchParams.set("nativeHarness", query.nativeHarness)
  else url.searchParams.set("connectionId", query.connectionId)
}
