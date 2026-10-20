import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { certifiedHostedWorkerArtifact } from "../../../claxedo-server/src/deployments/hosted-workerd/certified-worker-artifacts"
import { renderWorkerWranglerConfig } from "../../../claxedo-server/scripts/deploy/wrangler-config"
import { SERVER_DIR } from "./node-loader"

const CONFIG_DIRECTORY = path.join(SERVER_DIR, "scripts")

export type HostedWranglerConfig = {
  production: string
  e2e: string
}

export function renderHostedE2eWranglerConfig(publicOriginHost: string): HostedWranglerConfig {
  const production = renderWorkerWranglerConfig({
    workerName: "claxedo-hosted-e2e",
    artifact: certifiedHostedWorkerArtifact("user-deployed-better-auth-d1-agent-plugins-full-hosted"),
    configDirectory: CONFIG_DIRECTORY,
    authDatabase: { name: "claxedo-hosted-e2e-auth", id: "11111111-1111-4111-8111-111111111111" },
    controlPlaneDatabase: { name: "claxedo-hosted-e2e-control", id: "22222222-2222-4222-8222-222222222222" },
    controlPlaneMigrationsDir: "../migrations/control-plane",
    requestLimiterNamespaceId: "1930000001",
    documentsBucket: "claxedo-documents-e2e",
    agentPluginsBucket: "claxedo-agent-plugins-e2e",
    publicOriginHost,
    variables: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "user-deployed",
      CLAXEDO_SANDBOX_POSTURE: "full-hosted",
    },
  })
  return { production, e2e: production }
}

export async function writeHostedE2eWranglerConfig(publicOriginHost: string) {
  const file = path.join(CONFIG_DIRECTORY, `.wrangler-hosted-e2e-${randomUUID()}.toml`)
  const { e2e } = renderHostedE2eWranglerConfig(publicOriginHost)
  await fs.writeFile(file, e2e, { flag: "wx", mode: 0o600 })
  return file
}
