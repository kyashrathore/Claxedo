import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { isMissingFile, writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { sessionMcpServers, type HarnessServices, type StartInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { piMcpServerConfig } from "../../profiles/pi"
import { installPiExtension } from "./extension"

export const PI_MCP_HANDOFF = "CLAXEDO_PI_MCP_HANDOFF"
const EXTENSION_FILE = "claxedo-mcp.ts"

const PI_MCP_EXTENSION_SOURCE = `import { readFile, rm } from "node:fs/promises"

export default async function (pi) {
  const file = process.env.${PI_MCP_HANDOFF}
  delete process.env.${PI_MCP_HANDOFF}
  if (!file) throw new Error("Claxedo's MCP handoff is not named")
  let servers
  try { servers = JSON.parse(await readFile(file, "utf8")) }
  finally { await rm(file, { force: true }) }
  const refused = []
  for (const [name, config] of Object.entries(servers)) {
    try { pi.registerMcpServer(name, config) }
    catch (error) { refused.push(name + ": " + (error instanceof Error ? error.message : String(error))) }
  }
  if (refused.length) pi.on("session_start", (_event, ctx) => ctx.ui.notify("Claxedo could not add these MCP servers to Pi:\\n" + refused.join("\\n"), "error"))
}
`

export type PiMcpHandoff = { args: string[]; env: Record<string, string>; consumed(): Promise<void>; discard(): Promise<void> }

function piMcpServers(input: StartInput, services: Pick<HarnessServices, "firstPartyMcp">) {
  const servers = sessionMcpServers(input, services, { includeFirstParty: input.locality === "local",
    duplicate: (name) => new TransportError("pi", "configuration", `Duplicate Pi MCP server ${name}`) })
  const stdio = input.locality === "local" ? undefined : servers.find((server) => server.kind === "stdio")
  if (stdio) throw new TransportError("pi", "configuration", `Pi cannot run stdio MCP server ${stdio.name} for a remote session`)
  return Object.fromEntries(servers.map((server) => [server.name, piMcpServerConfig(server)]))
}

export async function piMcpHandoff(stateRoot: string, input: StartInput, services: Pick<HarnessServices, "firstPartyMcp">): Promise<PiMcpHandoff | undefined> {
  const servers = piMcpServers(input, services)
  if (!Object.keys(servers).length) return undefined
  const extension = await installPiExtension(stateRoot, EXTENSION_FILE, PI_MCP_EXTENSION_SOURCE)
  const file = path.join(stateRoot, "mcp-handoff", `${randomUUID()}.json`)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writePrivateFileAtomic(file, JSON.stringify(servers))
  return {
    args: ["-e", extension], env: { [PI_MCP_HANDOFF]: file },
    consumed: async () => {
      try { await fs.access(file) }
      catch (error) { if (isMissingFile(error)) return; throw error }
      throw new TransportError("pi", "protocol", "Pi did not load Claxedo's MCP extension, so the session's MCP servers were not handed over")
    },
    discard: () => fs.rm(file, { force: true }),
  }
}
