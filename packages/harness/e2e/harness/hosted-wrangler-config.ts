import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { certifiedHostedWorkerArtifact } from "../../../claxedo-server/src/deployments/hosted-workerd/certified-worker-artifacts"
import { renderEdgeWorkerWranglerConfig, renderWorkerWranglerConfig } from "../../../claxedo-server/scripts/deploy/wrangler-config"
import { stageWorkerControlPlaneMigrations } from "../../../claxedo-server/scripts/deploy/staged-control-plane-migrations"
import { SERVER_DIR } from "./node-loader"

const CONFIG_DIRECTORY = path.join(SERVER_DIR, "scripts")

/** The control plane's Workers as a deploy renders them: the one Worker, or with edge reads on the writer and the edge that forwards to it. */
export type HostedWranglerConfig = {
  writer: string
  edge?: string
}

export function renderHostedE2eWranglerConfig(controlPlaneMigrationsDir: string, publicOriginHost: string, edgeReads: boolean): HostedWranglerConfig {
  const input = {
    workerName: "claxedo-hosted-e2e",
    artifact: certifiedHostedWorkerArtifact("user-deployed-better-auth-d1-agent-plugins-full-hosted"),
    configDirectory: CONFIG_DIRECTORY,
    authDatabase: { name: "claxedo-hosted-e2e-auth", id: "11111111-1111-4111-8111-111111111111" },
    controlPlaneDatabase: { name: "claxedo-hosted-e2e-control", id: "22222222-2222-4222-8222-222222222222" },
    controlPlaneMigrationsDir,
    requestLimiterNamespaceId: "1930000001",
    documentsBucket: "claxedo-documents-e2e",
    agentPluginsBucket: "claxedo-agent-plugins-e2e",
    publicOriginHost,
    variables: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "user-deployed",
      CLAXEDO_SANDBOX_POSTURE: "full-hosted",
      ...(edgeReads ? { CLAXEDO_D1_EDGE_READS: "on" } : {}),
    },
  }
  if (!edgeReads) return { writer: renderWorkerWranglerConfig(input) }
  const split = { ...input, edgeWorkerName: "claxedo-hosted-e2e-edge" }
  return { writer: renderWorkerWranglerConfig(split), edge: renderEdgeWorkerWranglerConfig(split) }
}

/**
 * Writes the configs beside the server's scripts, where their relative paths
 * resolve; answers their files. `CLAXEDO_E2E_D1_EDGE_READS=on` runs the stack
 * as a deployment that reads at the edge; unset, as the default one Worker.
 */
export async function writeHostedE2eWranglerConfig(publicOriginHost: string) {
  // The deployed baseline is rendered from every owner's, so the run applies a
  // staged copy rather than the host's own source directory.
  const staged = stageWorkerControlPlaneMigrations({
    configDirectory: CONFIG_DIRECTORY,
    stageInto: await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-hosted-e2e-migrations-")),
  })
  const rendered = renderHostedE2eWranglerConfig(staged.migrationsDir, publicOriginHost, process.env.CLAXEDO_E2E_D1_EDGE_READS === "on")
  const files: { writer: string; edge?: string } = { writer: "" }
  for (const role of ["writer", "edge"] as const) {
    const config = rendered[role]
    if (config === undefined) continue
    files[role] = path.join(CONFIG_DIRECTORY, `.wrangler-hosted-e2e-${role}-${randomUUID()}.toml`)
    await fs.writeFile(files[role], config, { flag: "wx", mode: 0o600 })
  }
  return files
}
