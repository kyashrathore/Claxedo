import path from "node:path"
import { ACP_SCRIPT_DIR_ENV } from "./script"
import { sendJson } from "../transport"
import { directTransport } from "../transport"

export const STARTUP_ACP_HARNESS = { id: "scripted-startup-acp", access: "connection" } as const

export async function installStartupAcp(url: string, scriptDir: string) {
  await sendJson(directTransport, "PUT", `${url}/api/claxedo/agent-config/connections/${STARTUP_ACP_HARNESS.id}`, {
    connectionId: STARTUP_ACP_HARNESS.id,
    providerKey: "acp",
    configRevision: 1,
    enabled: true,
    config: {
      label: "Scripted startup ACP",
      connection: { kind: "process", command: process.execPath,
        args: [path.join(import.meta.dirname, "startup-agent.ts")], env: { [ACP_SCRIPT_DIR_ENV]: scriptDir } },
      modelSelection: { status: "optional" },
    },
  }, "Scripted startup ACP connection setup")
}
