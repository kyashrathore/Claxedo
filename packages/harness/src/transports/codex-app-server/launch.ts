import { stringRecord } from "@claxedo/helpers"
import type { HarnessServices, StartInput } from "../../contract"
import { codexProfileHome, prepareCodexProfile } from "../../profiles/codex"
import type { CodexTransportOptions } from "./index"
import { CodexRpc } from "./rpc"

export async function spawnCodexProfile(input: StartInput, options: CodexTransportOptions, services: HarnessServices, signal: AbortSignal) {
  const profileInput = { homeRoot: options.homeRoot, owner: input.owner, credentials: input.credentials, projection: input.projection }
  await services.recordHomeUse(codexProfileHome(profileInput))
  const profile = await prepareCodexProfile({ ...profileInput, ownerHome: options.ownerHome })
  const env = { ...stringRecord(options.env ?? process.env), CODEX_HOME: profile.home }
  const owned = await services.spawn({ file: options.binary, args: ["app-server", "--listen", "stdio://"], cwd: input.directory, env },
    { role: "harness", label: "Codex app-server", sessionId: input.sessionId, home: profile.home, signal })
  return { rpc: new CodexRpc(owned, services.clock), profile }
}
