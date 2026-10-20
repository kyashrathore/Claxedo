import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { certifiedHostedWorkerArtifact } from "../../../claxedo-server/src/deployments/hosted-workerd/certified-worker-artifacts"
import { renderWorkerWranglerConfig } from "../../../claxedo-server/scripts/deploy/wrangler-config"
import { stageWorkerControlPlaneMigrations } from "../../../claxedo-server/scripts/deploy/staged-control-plane-migrations"
import { SERVER_DIR } from "./node-loader"

const CONFIG_DIRECTORY = path.join(SERVER_DIR, "scripts")

export type HostedWranglerConfig = {
  production: string
  e2e: string
}

export function renderHostedE2eWranglerConfig(controlPlaneMigrationsDir: string, publicOriginHost: string): HostedWranglerConfig {
  const production = renderWorkerWranglerConfig({
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
  })
  return { production, e2e: production }
}

/** The certified full-hosted Worker with the registry test key, which the app-plugin flows' test registry is signed with. */
export const APP_PLUGIN_TEST_WORKER = path.join(SERVER_DIR, "src/plugin-backends/fixtures/full-hosted.fixture.cf.ts")

function withMain(config: string, main: string): string {
  return config.replace(/^main = .*$/m, `main = ${JSON.stringify(path.relative(CONFIG_DIRECTORY, main))}`)
}

export async function writeHostedE2eWranglerConfig(publicOriginHost: string, options: { readonly main?: string } = {}) {
  const file = path.join(CONFIG_DIRECTORY, `.wrangler-hosted-e2e-${randomUUID()}.toml`)
  // The deployed baseline is rendered from every owner's, so the run applies a
  // staged copy rather than the host's own source directory.
  const staged = stageWorkerControlPlaneMigrations({
    configDirectory: CONFIG_DIRECTORY,
    stageInto: await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-hosted-e2e-migrations-")),
  })
  const { e2e } = renderHostedE2eWranglerConfig(staged.migrationsDir, publicOriginHost)
  await fs.writeFile(file, options.main ? withMain(e2e, options.main) : e2e, { flag: "wx", mode: 0o600 })
  return file
}
