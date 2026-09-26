// The harness materializes fixtures through the app's real production writers
// rather than reimplementing them, so a fixture is wrong in exactly the ways
// production is wrong. Those writers live in sibling packages that this
// package's TypeScript project deliberately does not absorb: `rootDir` is
// `packages/claxedo-app`, and widening it would pull claxedo-server-core and
// workspace-runtime into every harness typecheck just to name four exports.
//
// So the import stays dynamic, by source path, and the contract is declared
// here instead of at each call site. `import(specifier)` with a non-literal
// specifier yields `any`, which is the only thing TypeScript can say about a
// module it was never shown. What it cannot check, we check: each loader
// verifies that the exports it is about to call actually exist, so a rename in
// a sibling package fails at this boundary naming the module and the export,
// instead of surfacing as "undefined is not a function" inside a materializer
// run that has already written half a fixture.
//
// Signatures remain unverifiable at runtime — that is inherent to loading a
// module by path — but they are stated once, here, where they can be reviewed
// against the real exports, rather than copied into five call sites.

import type { ClientPresentationEvent } from "@claxedo/agent-event-runtime/client-presentation"
import { isRecord } from "./json-fields"

const WORKSPACE_STORE = "../../../claxedo-server-core/src/workspace/store/index.ts"
const SESSION_META = "../../../claxedo-server-core/src/session/meta/index.ts"
const PLATFORM_DB = "../../../claxedo-server-core/src/platform/db/index.ts"
const RUNTIME_STORE = "../../../workspace-runtime/src/store.ts"

/** A workspace row as the production store hands it back. */
export type RegisteredWorkspace = {
  id: string
  project_id?: string
  directory: string
  kind: "local" | "cloud"
}

type WorkspaceStore = {
  ensureWorkspace: (input: {
    workspaceId: string
    project_id: string
    project_name: string
    workspace_name: string
    directory: string
  }) => Promise<{ id: string } | undefined>
  getWorkspace: (id: string) => Promise<RegisteredWorkspace | undefined>
}

type SessionMetaStore = {
  putSessionMeta: (
    sessionID: string,
    value: {
      ws: RegisteredWorkspace
      workspaceID: string
      directory: string
      host: "workspace"
      title: string
      createdAt: number
      updatedAt: number
    },
  ) => Promise<unknown>
}

type PlatformDatabase = {
  ClaxedoDB: {
    close(): void
  }
}

type RuntimeStoreModule = {
  RuntimeStore: new (root: string) => {
    bindSession(input: {
      sessionId: string
      directory: string
      title: string
      agentSessionId: string
      createdAt: number
      updatedAt: number
    }): void
    updateSessionConfig(
      id: string,
      update: { harness: { id: "opencode"; access: "native" }; variant: null; agent: null },
      input: { directory: string },
    ): unknown
    appendEvent(input: { sessionId: string; agentSessionId: string; payload: ClientPresentationEvent }): unknown
    flush(): void
    close(): void
  }
}

/** True when every named export is present and callable. */
function exportsCallables(module: unknown, names: readonly string[]): boolean {
  if (!isRecord(module)) return false
  return names.every((name) => typeof module[name] === "function")
}

function missing(specifier: string, names: readonly string[]): Error {
  return new Error(`${specifier} does not export ${names.join(", ")} — the harness contract is out of date`)
}

function isWorkspaceStore(module: unknown): module is WorkspaceStore {
  return exportsCallables(module, ["ensureWorkspace", "getWorkspace"])
}

function isSessionMetaStore(module: unknown): module is SessionMetaStore {
  return exportsCallables(module, ["putSessionMeta"])
}

function isRuntimeStoreModule(module: unknown): module is RuntimeStoreModule {
  return exportsCallables(module, ["RuntimeStore"])
}

function isPlatformDatabase(module: unknown): module is PlatformDatabase {
  return isRecord(module) && isRecord(module.ClaxedoDB) && typeof module.ClaxedoDB.close === "function"
}

/** Workspace rows: the same writer the running app uses to register a workspace. */
export async function loadWorkspaceStore(): Promise<WorkspaceStore> {
  const module: unknown = await import(WORKSPACE_STORE)
  if (!isWorkspaceStore(module)) throw missing(WORKSPACE_STORE, ["ensureWorkspace", "getWorkspace"])
  return module
}

/** Session identity as the control-plane inventory reads it before runtimes start. */
export async function loadSessionMetaStore(): Promise<SessionMetaStore> {
  const module: unknown = await import(SESSION_META)
  if (!isSessionMetaStore(module)) throw missing(SESSION_META, ["putSessionMeta"])
  return module
}

/** The journal writer that owns persisted transcript records. */
export async function loadRuntimeStore(): Promise<RuntimeStoreModule> {
  const module: unknown = await import(RUNTIME_STORE)
  if (!isRuntimeStoreModule(module)) throw missing(RUNTIME_STORE, ["RuntimeStore"])
  return module
}

/** The process-global database singleton a data-directory scope must close. */
export async function loadPlatformDatabase(): Promise<PlatformDatabase> {
  const module: unknown = await import(PLATFORM_DB)
  if (!isPlatformDatabase(module)) throw missing(PLATFORM_DB, ["ClaxedoDB"])
  return module
}
