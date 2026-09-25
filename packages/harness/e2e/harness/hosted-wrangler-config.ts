import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { renderBetterAuthD1WranglerConfig } from "../../../claxedo-server/scripts/deploy/release-better-auth-d1"
import { SERVER_DIR } from "./node-loader"

export type HostedWranglerConfig = {
  production: string
  e2e: string
}

export function renderHostedE2eWranglerConfig(): HostedWranglerConfig {
  const production = renderBetterAuthD1WranglerConfig({
    staging: true,
    mode: "cutover",
    agentPlugins: { bucketName: "claxedo-agent-plugins-e2e" },
    sandbox: { driver: "cloudflare" },
    authDatabaseId: "11111111-1111-4111-8111-111111111111",
    authDatabaseName: "claxedo-hosted-e2e-auth",
    controlPlaneDatabaseId: "22222222-2222-4222-8222-222222222222",
    controlPlaneDatabaseName: "claxedo-hosted-e2e-control",
    namespaceId: "1930000001",
    controlPlaneMigrationsDir: "../migrations/control-plane",
  })
  return { production, e2e: production }
}

export async function writeHostedE2eWranglerConfig() {
  const file = path.join(SERVER_DIR, "scripts", `.wrangler-hosted-e2e-${randomUUID()}.toml`)
  const { e2e } = renderHostedE2eWranglerConfig()
  await fs.writeFile(file, e2e, { flag: "wx", mode: 0o600 })
  return file
}
