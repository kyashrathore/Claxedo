import { Hono } from "hono"
import { createSandboxPhaseTimer, type SandboxRuntimeStartPhase } from "@claxedo/sandbox-contract"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { RUNTIME_START_PHASES_PATH } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { controlPlaneOnly } from "./control-plane-only"

/**
 * The start phases this runtime times while it boots, handed to the control
 * plane once. A process an ensure reuses for a later lease epoch did not boot
 * again, so a second take answers no phases rather than its first boot's.
 */
export function runtimeStartPhases() {
  const timer = createSandboxPhaseTimer<SandboxRuntimeStartPhase>()
  let repoSizeBytes: number | undefined
  let taken = false
  const routes: WorkspaceRuntimeRouteContribution = {
    id: "start-phases",
    mount: () => {
      const app = new Hono()
      app.use(RUNTIME_START_PHASES_PATH, controlPlaneOnly("Only the control plane takes this runtime's start phases"))
      app.post(RUNTIME_START_PHASES_PATH, (c) => {
        const report = taken ? { phases: [] } : { phases: timer.timings(), ...(repoSizeBytes === undefined ? {} : { repoSizeBytes }) }
        taken = true
        return c.json(report)
      })
      return { path: "/", routes: app, dispose: () => {} }
    },
  }
  return {
    measure: timer.measure,
    repositorySize: (bytes: number) => {
      repoSizeBytes = bytes
    },
    routes,
  }
}
