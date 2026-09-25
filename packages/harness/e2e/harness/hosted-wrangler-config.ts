import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { renderBetterAuthD1WranglerConfig } from "../../../claxedo-server/scripts/deploy/release-better-auth-d1"
import { SERVER_DIR } from "./node-loader"

const PRIVATE_FETCH_FLAG = 'compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]'
const LOCAL_FETCH_FLAG = 'compatibility_flags = ["nodejs_compat"]'

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
  if (production.split(PRIVATE_FETCH_FLAG).length !== 2) {
    throw new Error("The certified hosted Worker no longer has exactly one private-fetch flag")
  }
  // Local workerd must fetch the loopback sandbox Worker; production refuses private fetch targets.
  return { production, e2e: production.replace(PRIVATE_FETCH_FLAG, LOCAL_FETCH_FLAG) }
}

export async function writeHostedE2eWranglerConfig() {
  const file = path.join(SERVER_DIR, "scripts/deploy", `.wrangler-hosted-e2e-${randomUUID()}.toml`)
  const { e2e } = renderHostedE2eWranglerConfig()
  await fs.writeFile(file, e2e, { flag: "wx", mode: 0o600 })
  return file
}
