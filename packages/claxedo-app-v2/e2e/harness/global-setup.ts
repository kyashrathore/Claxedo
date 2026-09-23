import { appChoice, ensureAppBuilt } from "./app"
import { DAEMON_PORT_ENV, fixedDaemonPort, reservePort } from "./ports"

export default async function globalSetup() {
  const app = appChoice()
  const daemonPort = fixedDaemonPort() ?? (await reservePort())
  process.env[DAEMON_PORT_ENV] = String(daemonPort)
  const serverUrl = `http://127.0.0.1:${daemonPort}`
  const result = await ensureAppBuilt(app, { serverUrl })
  const how = result.built ? `built in ${result.ms} ms` : "already current"
  console.log(`[harness] app=${app} served from ${result.distDir} for ${serverUrl} (${how})`)
}
