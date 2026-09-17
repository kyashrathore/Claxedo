import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER } from "../management-auth"
import { WorkspaceRuntimeRoutes } from "../routes/manifest"
import type { WorkspaceCapabilities } from "../capabilities"
import type { RuntimeSnapshot } from "../routes/config"
import type { GitCommitSummary, GitWorktreeStatus } from "../workspace-files/git-worktree"
import { fileClient, filesClient, findClient, type WorkspaceFileClient, type WorkspaceFilesClient, type WorkspaceFindClient } from "./files"
import {
  createWorkspaceRuntimeCaller,
  type WorkspaceRuntimeCall,
  type WorkspaceRuntimeCaller,
  type WorkspaceRuntimeClientOptions,
  type WorkspaceRuntimeRequestOptions,
} from "./request"
import {
  permissionClient,
  questionClient,
  sessionClient,
  type WorkspacePermissionClient,
  type WorkspaceQuestionClient,
  type WorkspaceSessionClient,
} from "./session"
import {
  agentClient,
  commandClient,
  mcpClient,
  vcsClient,
  type WorkspaceAgentClient,
  type WorkspaceCommandClient,
  type WorkspaceMcpClient,
  type WorkspaceVcsClient,
} from "./workspace"

export type WorkspaceRuntimeConfigApplyOptions = {
  token?: string
  headers?: HeadersInit
}

export type WorkspaceRuntimeHealth = {
  ok: boolean
  status: "ready" | "applying" | "error"
  service: "workspace-runtime"
  routeAuthBoundary: "relay-host-auth" | "loopback-only" | "private-network-host-guard" | "private-network-dev-unsafe"
  serviceExposure: {
    source: "loopback" | "driver-service-url"
    access: "private" | "public" | "driver-authenticated" | "unknown"
    driver?: string
    fallbackAccess?: "private" | "public" | "driver-authenticated" | "unknown"
    note?: string
  }
  exposure?: { kind: "loopback" | "relay" | "private-network-host-guard" | "private-network-dev-unsafe" | "embedded" }
}

type Options = WorkspaceRuntimeRequestOptions
type Query = Record<string, string | undefined>

export type WorkspaceRuntimeClient = {
  health: () => Promise<WorkspaceRuntimeHealth>
  capabilities: () => Promise<WorkspaceCapabilities>
  applyConfig: (snapshot: RuntimeSnapshot, options?: WorkspaceRuntimeConfigApplyOptions) => Promise<void>
  eventsUrl: () => URL
  session: WorkspaceSessionClient
  permission: WorkspacePermissionClient
  question: WorkspaceQuestionClient
  file: WorkspaceFileClient
  find: WorkspaceFindClient
  files: WorkspaceFilesClient
  vcs: WorkspaceVcsClient
  mcp: WorkspaceMcpClient
  command: WorkspaceCommandClient
  agent: WorkspaceAgentClient
  diff: {
    targets: (options?: Options) => Promise<unknown>
    vcs: (query?: Query, options?: Options) => Promise<unknown>
    file: (file: string, query?: Query, options?: Options) => Promise<unknown>
    refs: (options?: Options) => Promise<unknown>
  }
  git: {
    snapshot: (path: string, options?: Options) => Promise<unknown>
    commit: (body: { path: string; content: string; message: string; expected?: { baseCommit?: string; baseBlobSha?: string } }, options?: Options) => Promise<unknown>
    status: (options?: Options) => Promise<GitWorktreeStatus>
    stage: (input: { paths: string[] }, options?: Options) => Promise<void>
    unstage: (input: { paths: string[] }, options?: Options) => Promise<void>
    commitStaged: (input: { message: string; amend?: boolean }, options?: Options) => Promise<{ commit: string }>
    push: (input?: { setUpstream?: boolean }, options?: Options) => Promise<{ remote: string; branch: string }>
    log: (input?: { limit?: number }, options?: Options) => Promise<{ commits: GitCommitSummary[] }>
  }
  pty: {
    list: (options?: Options) => Promise<unknown>
    create: (body: unknown, options?: Options) => Promise<unknown>
    get: (id: string, options?: Options) => Promise<unknown>
    update: (id: string, body: unknown, options?: Options) => Promise<unknown>
    remove: (id: string, options?: Options) => Promise<boolean>
    connectUrl: (id: string, cursor?: number) => URL
  }
  process: {
    list: (options?: Options) => Promise<unknown>
    create: (body: unknown, options?: Options) => Promise<unknown>
    update: (id: string, body: unknown, options?: Options) => Promise<unknown>
    remove: (id: string, options?: Options) => Promise<boolean>
    start: (id: string, body?: unknown, options?: Options) => Promise<unknown>
    stop: (id: string, options?: Options) => Promise<boolean>
    restart: (id: string, options?: Options) => Promise<unknown>
    logs: (query?: Query, options?: Options) => Promise<string>
  }
}

export function createWorkspaceRuntimeClient(options: WorkspaceRuntimeClientOptions): WorkspaceRuntimeClient {
  const caller = createWorkspaceRuntimeCaller(options)
  const data = async <T>(input: WorkspaceRuntimeCall) => (await caller.call<T>(input)).data
  const at = (family: string, ...parts: string[]) => [family, ...parts.map(encodeURIComponent)].join("/")
  const file = fileClient(caller)
  const find = findClient(caller)

  return {
    health: () => data({ operation: "health", path: WorkspaceRuntimeRoutes.health }),
    capabilities: () => data({ operation: "capabilities", path: WorkspaceRuntimeRoutes.capabilities }),
    applyConfig: async (snapshot, input = {}) => {
      await caller.send({
        operation: "config.apply",
        method: "POST",
        path: WorkspaceRuntimeRoutes.config,
        headers: {
          ...(input.headers ? Object.fromEntries(new Headers(input.headers)) : {}),
          ...(input.token ? { [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: input.token } : {}),
        },
        body: snapshot,
      })
    },
    eventsUrl: () => caller.url(WorkspaceRuntimeRoutes.events),
    session: sessionClient(caller),
    permission: permissionClient(caller),
    question: questionClient(caller),
    file,
    find,
    files: filesClient(file, find),
    vcs: vcsClient(caller),
    mcp: mcpClient(caller),
    command: commandClient(caller),
    agent: agentClient(caller),
    diff: {
      targets: (options) => data({ operation: "diff.targets", path: `${WorkspaceRuntimeRoutes.diff}/targets`, options }),
      vcs: (query = {}, options) => data({ operation: "diff.vcs", path: `${WorkspaceRuntimeRoutes.diff}/vcs`, query, options }),
      file: (file, query = {}, options) => data({ operation: "diff.file", path: `${WorkspaceRuntimeRoutes.diff}/vcs/file`, query: { ...query, file }, options }),
      refs: (options) => data({ operation: "diff.refs", path: `${WorkspaceRuntimeRoutes.diff}/refs`, options }),
    },
    git: {
      snapshot: (path, options) => data({ operation: "git.snapshot", path: `${WorkspaceRuntimeRoutes.git}/snapshot`, query: { path }, options }),
      commit: (body, options) => data({ operation: "git.commit", method: "POST", path: `${WorkspaceRuntimeRoutes.git}/commit`, body, options }),
      status: (options) => data({ operation: "git.status", path: `${WorkspaceRuntimeRoutes.git}/status`, options }),
      stage: async (body, options) => { await caller.send({ operation: "git.stage", method: "POST", path: `${WorkspaceRuntimeRoutes.git}/stage`, body, options }) },
      unstage: async (body, options) => { await caller.send({ operation: "git.unstage", method: "POST", path: `${WorkspaceRuntimeRoutes.git}/unstage`, body, options }) },
      commitStaged: (body, options) => data({ operation: "git.commitStaged", method: "POST", path: `${WorkspaceRuntimeRoutes.git}/commit-staged`, body, options }),
      push: (body = {}, options) => data({ operation: "git.push", method: "POST", path: `${WorkspaceRuntimeRoutes.git}/push`, body, options }),
      log: (query = {}, options) => data({ operation: "git.log", path: `${WorkspaceRuntimeRoutes.git}/log`, query, options }),
    },
    pty: {
      list: (options) => data({ operation: "pty.list", path: WorkspaceRuntimeRoutes.pty, options }),
      create: (body, options) => data({ operation: "pty.create", method: "POST", path: WorkspaceRuntimeRoutes.pty, body, options }),
      get: (id, options) => data({ operation: "pty.get", path: at(WorkspaceRuntimeRoutes.pty, id), options }),
      update: (id, body, options) => data({ operation: "pty.update", method: "PUT", path: at(WorkspaceRuntimeRoutes.pty, id), body, options }),
      remove: (id, options) => data({ operation: "pty.remove", method: "DELETE", path: at(WorkspaceRuntimeRoutes.pty, id), options }),
      connectUrl: (id, cursor) => caller.url(at(WorkspaceRuntimeRoutes.pty, id, "connect"), cursor === undefined ? {} : { cursor }),
    },
    process: {
      list: (options) => data({ operation: "process.list", path: WorkspaceRuntimeRoutes.process, options }),
      create: (body, options) => data({ operation: "process.create", method: "POST", path: WorkspaceRuntimeRoutes.process, body, options }),
      update: (id, body, options) => data({ operation: "process.update", method: "PUT", path: at(WorkspaceRuntimeRoutes.process, id), body, options }),
      remove: (id, options) => data({ operation: "process.remove", method: "DELETE", path: at(WorkspaceRuntimeRoutes.process, id), options }),
      start: (id, body, options) => data({ operation: "process.start", method: "POST", path: at(WorkspaceRuntimeRoutes.process, id, "start"), body: body ?? {}, options }),
      stop: (id, options) => data({ operation: "process.stop", method: "POST", path: at(WorkspaceRuntimeRoutes.process, id, "stop"), options }),
      restart: (id, options) => data({ operation: "process.restart", method: "POST", path: at(WorkspaceRuntimeRoutes.process, id, "restart"), options }),
      logs: async (query = {}, options) => (await caller.send({ operation: "process.logs", path: `${WorkspaceRuntimeRoutes.process}/logs`, query, options })).response.text(),
    },
  }
}

export type { WorkspaceRuntimeCaller }
