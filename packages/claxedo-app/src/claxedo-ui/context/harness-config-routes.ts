type HarnessDirectory = string
type HarnessConfigResource = "harness" | "harness/model" | "harness/options"
type HarnessSessionResource = "session" | "messages" | "todo" | "capabilities" | "config"

function harnessConfigPath(input: {
  resource?: HarnessConfigResource
  directory?: HarnessDirectory
  sessionId?: string
  harnessType?: string
}) {
  const url = new URL(`/api/claxedo/agent-config/${input.resource ?? "harness"}`, "http://claxedo.local")
  if (input.directory) url.searchParams.set("directory", input.directory)
  if (input.sessionId && input.sessionId !== "new") url.searchParams.set("sessionId", input.sessionId)
  if (input.harnessType) url.searchParams.set("type", input.harnessType)
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
  harnessType?: string
}) {
  const url = new URL(`/${input.resource}`, "http://claxedo.local")
  url.searchParams.set("directory", input.directory)
  if (input.harnessType) url.searchParams.set("harness", input.harnessType)
  return `${url.pathname}${url.search}`
}
