import { getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"

function normalized(url: string | undefined) {
  return normalizeUrl(url) ?? "default"
}

// Runtime records are fetched against a concrete server either way (the
// backend falls back to `getDefaultBaseUrl()` when no baseUrl is given), so
// the KEY resolves the fallback too. Leaving it as the "default" placeholder
// split one resource into two cache entries — a caller passing the server URL
// and a caller passing nothing each fetched `/api/claxedo/workspace/resolve`
// for the same directory (measured on the launch-project perf lane), because
// their keys never matched.
function runtimeServer(url: string | undefined) {
  return normalizeUrl(url) ?? normalizeUrl(getDefaultBaseUrl()) ?? "default"
}

// Runtime VCS is keyed DIRECTORY-major (like `directory.fileStatus` below), so
// the per-directory prefix is a real key family: `WorkspaceVcsCacheHonesty`
// owns the freshness of every VCS entry for one worktree and invalidates the
// family, without having to know which SDK scope resolved the directory to a
// workspaceId (a signed pane and the directory scope can disagree, and a
// workspace can be resolved after the first read).
function runtimeVcsDirectoryKey(baseUrl: string | undefined, directory: string) {
  return ["runtime", runtimeServer(baseUrl), "vcs", directory] as const
}

/**
 * The scope of a control-plane catalog read that is about the server itself and
 * about no workspace on it — the central server's own runtime. It is a real
 * scope, not a placeholder: the central runtime answers `/provider` for its own
 * harness installation, and that answer belongs to nothing else.
 */
const CENTRAL_RUNTIME_SCOPE = "central"

/**
 * The RESOLVED workspace identity (`kind:id`) a directory-scoped key carries.
 *
 * A query that fires before workspace resolution answers from a different
 * authority than the same query after it, so the resolution is part of the key:
 * the pre-resolution answer is never served to a resolved reader. One builder
 * for every family that carries it (`agents`, `commands`, `config`,
 * `fileStatus`) so a reader and a writer cannot disagree about its shape.
 */
export function workspaceQueryKey(
  workspace?: { kind?: string | null; workspaceId?: string | null } | null,
) {
  return workspace ? `${workspace.kind ?? ""}:${workspace.workspaceId ?? ""}` : ""
}

export const queryKeys = {
  controlPlane: {
    projects: (baseUrl?: string) => ["controlPlane", normalized(baseUrl), "projects"] as const,
    // A harness catalog and its provider authentication both belong to (the
    // machine serving the scope, the workspace-or-directory scope, the harness).
    // The same harness exposes different models — and holds different
    // credentials — on two machines, so neither the catalog nor the auth entry
    // can be shared by name alone. Both keys carry all three components; the
    // harness is required because "no harness" is not a catalog, it is an
    // unresolved question.
    providers: (baseUrl: string | undefined, scope: string | undefined, harnessType: string) =>
      ["controlPlane", normalized(baseUrl), "providers", scope ?? CENTRAL_RUNTIME_SCOPE, harnessType] as const,
    providerAuth: (baseUrl: string | undefined, scope: string | undefined, harnessType: string) =>
      ["controlPlane", normalized(baseUrl), "providerAuth", scope ?? CENTRAL_RUNTIME_SCOPE, harnessType] as const,
  },
  shell: {
    // Commands are a harness's command set for one worktree, served by the
    // machine that owns the workspace — same key family as `directory.agents`.
    commands: (
      baseUrl: string | undefined,
      directory: string,
      harnessType?: string,
      workspaceKey?: string,
    ) => ["shell", normalized(baseUrl), "commands", directory, harnessType ?? "", workspaceKey ?? ""] as const,
    sessionInventory: (baseUrl?: string) => ["shell", normalized(baseUrl), "sessionInventory"] as const,
    sessionList: (baseUrl: string | undefined, query: unknown) =>
      ["shell", normalized(baseUrl), "sessionList", query] as const,
    sessionBase: (owner: string, sessionID: string) => ["shell", "claxedo-client", owner, "session-base", sessionID] as const,
  },
  directory: {
    project: (baseUrl: string | undefined, directory: string) =>
      ["directory", normalized(baseUrl), "project", directory] as const,
    config: (baseUrl: string | undefined, directory: string, workspaceKey?: string) =>
      ["directory", normalized(baseUrl), "config", directory, workspaceKey ?? ""] as const,
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
    fileStatus: (baseUrl: string | undefined, directory: string, workspaceKey?: string) =>
      ["directory", normalized(baseUrl), "fileStatus", directory, workspaceKey ?? ""] as const,
    projectMeta: (directory: string) => ["directory", "local", "projectMeta", directory] as const,
    icon: (directory: string) => ["directory", "local", "icon", directory] as const,
    sessionCache: (directory: string) => ["directory", "local", "sessionCache", directory] as const,
  },
  runtime: {
    workspace: (input: { baseUrl?: string; directory?: string; workspaceId?: string; create?: boolean }) =>
      [
        "runtime",
        runtimeServer(input.baseUrl),
        "workspace",
        input.workspaceId ?? "",
        input.directory ?? "",
        input.create === true ? "create" : "read",
      ] as const,
    /** Every VCS entry for one worktree, whichever workspace resolved it. */
    vcsDirectory: runtimeVcsDirectoryKey,
    vcs: (baseUrl: string | undefined, directory: string, workspaceId?: string) =>
      [...runtimeVcsDirectoryKey(baseUrl, directory), workspaceId ?? ""] as const,
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
