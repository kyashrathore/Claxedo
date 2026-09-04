import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { machineInstalledPlugins } from "./machine-installed"

/** Unsigned, read-only D3 discovery route: `GET /api/claxedo/plugins/machine-installed`. */
export function MachineInstalledDiscoveryRoutes() {
  const app = new Hono()
  app.get("/", async (c) => {
    const home = os.homedir()
    const codexHome = process.env.CODEX_HOME ?? path.join(home, ".codex")
    const result = await machineInstalledPlugins({ home, codexHome })
    return c.json(result)
  })
  return app
}
