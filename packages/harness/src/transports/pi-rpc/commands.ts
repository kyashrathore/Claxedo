import { PiTransportError } from "./errors"
import type { PiRpc } from "./rpc"

export async function piCommands(rpc: PiRpc) {
  const result = await rpc.request("get_commands")
  if (!result || typeof result !== "object" || !("commands" in result) || !Array.isArray(result.commands)) {
    throw new PiTransportError("protocol", "Pi returned an invalid command list")
  }
  return result.commands.filter((value: unknown) => {
    if (!value || typeof value !== "object" || !("sourceInfo" in value)) return true
    const info = value.sourceInfo
    return !info || typeof info !== "object" || !("source" in info) || info.source !== "inline"
  }).map((value: unknown) => {
    if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string") {
      throw new PiTransportError("protocol", "Pi command has no name")
    }
    return { name: value.name, description: "description" in value && typeof value.description === "string" ? value.description : undefined }
  })
}
