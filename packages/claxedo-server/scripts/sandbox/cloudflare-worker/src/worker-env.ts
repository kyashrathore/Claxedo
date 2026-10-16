import type { EgressKV } from "./egress-store"
import type { RuntimeBuildEnv } from "./runtime-integrity"
import type { RegistryR2 } from "./sandbox-registry"
import type { IdleEnv } from "./workspace-idle"
import type { WorkspaceSandbox } from "./workspace-sandbox"

// A stub's `fetch` is the object's, in the DOM lib's Request and Response this
// Worker is written against; at runtime they are the same classes.
type WorkspaceSandboxStub = { fetch(request: Request): Promise<Response> } & Pick<WorkspaceSandbox,
  | "setCredentialHosts"
  | "configureWorkspaceIdle"
  | "ensureWorkspace"
  | "workspaceRunning"
  | "workspaceRuntimeReady"
  | "watchWorkspaceIdle"
  | "stopWorkspace"
  | "snapshotWorkspace"
  | "destroyWorkspace">

export interface WorkerEnv extends IdleEnv, RuntimeBuildEnv {
  WORKSPACE_SANDBOX: { getByName(name: string): WorkspaceSandboxStub }
  API_TOKEN: string
  EGRESS_SECRETS?: EgressKV
  /** The sandbox registry, which `GET /sandboxes` and therefore the control plane's GC read. */
  SANDBOX_REGISTRY?: RegistryR2
}
