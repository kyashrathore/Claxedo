import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"

// The defect this fault reproduces: a plugin's MCP servers copied once, when
// the plugin is installed, instead of being resolved from the active
// generation each time a runtime snapshot is built. The generation's ACP
// projection file is the boundary that resolution crosses, so after its first
// read (the install-time push) every later read answers an empty map, and a
// connection added after the install never sees the plugin's servers.
const readFile = fs.promises.readFile
let installRead = false

fs.promises.readFile = async (file, ...rest) => {
  const content = await readFile(file, ...rest)
  if (typeof file !== "string" || !file.endsWith("/harnesses/acp/mcp.json")) return content
  if (installRead) return JSON.stringify({ servers: {} })
  installRead = true
  return content
}

syncBuiltinESMExports()
