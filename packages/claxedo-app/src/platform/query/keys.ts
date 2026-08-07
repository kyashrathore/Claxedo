import { normalizeUrl } from "@/platform/api/api"

function normalized(url: string | undefined) {
  return normalizeUrl(url) ?? "default"
}

export const queryKeys = {
  controlPlane: {
    projects: (baseUrl?: string) => ["controlPlane", normalized(baseUrl), "projects"] as const,
    // Harness catalogs are runtime-owned: the same harness may expose different
    // models in two workspaces. The stable workspace/directory scope isolates
    // those catalogs while allowing every pane for one runtime to share them.
    // The default OpenCode catalog remains server-wide for its SDK-backed path.
    providers: (baseUrl?: string, scope?: string, harnessType?: string) => harnessType
      ? ["controlPlane", normalized(baseUrl), "providers", scope ?? "", harnessType] as const
      : ["controlPlane", normalized(baseUrl), "providers"] as const,
    providerAuth: (baseUrl?: string, harnessType?: string) => harnessType
      ? ["controlPlane", normalized(baseUrl), "providerAuth", harnessType] as const
      : ["controlPlane", normalized(baseUrl), "providerAuth"] as const,
  },
  shell: {
    commands: (baseUrl: string | undefined, directory: string) => ["shell", normalized(baseUrl), "commands", directory] as const,
    sessionInventory: (baseUrl?: string) => ["shell", normalized(baseUrl), "sessionInventory"] as const,
    sessionList: (baseUrl: string | undefined, query: unknown) =>
      ["shell", normalized(baseUrl), "sessionList", query] as const,
    sessionBase: (owner: string, sessionID: string) => ["shell", "claxedo-client", owner, "session-base", sessionID] as const,
  },
  directory: {
    project: (baseUrl: string | undefined, directory: string) =>
      ["directory", normalized(baseUrl), "project", directory] as const,
    config: (baseUrl: string | undefined, directory: string) =>
      ["directory", normalized(baseUrl), "config", directory] as const,
    // `workspaceKey` carries the RESOLVED workspace identity (kind:id). The
    // agents queryFn branches on `workspace?.kind` (central agent-config vs
    // workspace runtime) — keying on the resolution means a query that fired
    // before the signed inventory loaded (workspace unresolved → central 404 →
    // []) re-fetches under a new key once the workspace resolves, instead of
    // serving the stale empty list forever.
    agents: (baseUrl: string | undefined, directory: string, harnessType?: string, workspaceKey?: string) =>
      ["directory", normalized(baseUrl), "agents", directory, harnessType ?? "", workspaceKey ?? ""] as const,
    path: (baseUrl: string | undefined, directory: string) =>
      ["directory", normalized(baseUrl), "path", directory] as const,
    projectMeta: (directory: string) => ["directory", "local", "projectMeta", directory] as const,
    icon: (directory: string) => ["directory", "local", "icon", directory] as const,
    sessionCache: (directory: string) => ["directory", "local", "sessionCache", directory] as const,
  },
  runtime: {
    workspace: (input: { baseUrl?: string; directory?: string; workspaceId?: string; create?: boolean }) =>
      [
        "runtime",
        normalized(input.baseUrl),
        "workspace",
        input.workspaceId ?? "",
        input.directory ?? "",
        input.create === true ? "create" : "read",
      ] as const,
    vcs: (baseUrl: string | undefined, directory: string, workspaceId?: string) =>
      ["runtime", normalized(baseUrl), "vcs", workspaceId ?? "", directory] as const,
  },
  session: {
    row: (baseUrl: string | undefined, directory: string, sessionID: string) =>
      ["session", normalized(baseUrl), "row", directory, sessionID] as const,
    messages: (baseUrl: string | undefined, directory: string, sessionID: string, before?: string) =>
      ["session", normalized(baseUrl), "messages", directory, sessionID, before ?? "head"] as const,
    diff: (baseUrl: string | undefined, directory: string, sessionID: string) =>
      ["session", normalized(baseUrl), "diff", directory, sessionID] as const,
    todo: (baseUrl: string | undefined, directory: string, sessionID: string) =>
      ["session", normalized(baseUrl), "todo", directory, sessionID] as const,
  },
}
