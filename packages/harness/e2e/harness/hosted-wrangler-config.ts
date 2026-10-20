import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { certifiedHostedWorkerArtifact } from "../../../claxedo-server/src/deployments/hosted-workerd/certified-worker-artifacts"
import { renderEdgeWorkerWranglerConfig, renderWorkerWranglerConfig } from "../../../claxedo-server/scripts/deploy/wrangler-config"
import { stageWorkerControlPlaneMigrations } from "../../../claxedo-server/scripts/deploy/staged-control-plane-migrations"
import { SERVER_DIR } from "./node-loader"

const CONFIG_DIRECTORY = path.join(SERVER_DIR, "scripts")

/** The control plane's two Workers as a deploy renders them: the writer and the edge that forwards to it. */
export type HostedWranglerConfig = {
  writer: string
  edge: string
}

export function renderHostedE2eWranglerConfig(controlPlaneMigrationsDir: string, publicOriginHost: string): HostedWranglerConfig {
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
    },
  }
  return { writer: renderWorkerWranglerConfig(input), edge: renderEdgeWorkerWranglerConfig({ ...input, edgeWorkerName: "claxedo-hosted-e2e-edge" }) }
}

/** Writes both configs beside the server's scripts, where their relative paths resolve; answers their files. */
export async function writeHostedE2eWranglerConfig(publicOriginHost: string) {
  // The deployed baseline is rendered from every owner's, so the run applies a
  // staged copy rather than the host's own source directory.
  const staged = stageWorkerControlPlaneMigrations({
    configDirectory: CONFIG_DIRECTORY,
    stageInto: await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-hosted-e2e-migrations-")),
  })
  const rendered = renderHostedE2eWranglerConfig(staged.migrationsDir, publicOriginHost)
  const files = { writer: "", edge: "" }
  for (const role of ["writer", "edge"] as const) {
    files[role] = path.join(CONFIG_DIRECTORY, `.wrangler-hosted-e2e-${role}-${randomUUID()}.toml`)
    await fs.writeFile(files[role], rendered[role], { flag: "wx", mode: 0o600 })
  }
  return files
}
