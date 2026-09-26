import { TransportError } from "../../contract/errors"
import type { PiRpc } from "./rpc"
import { PI_TITLE_COMMAND } from "./title"

export async function piCommands(rpc: PiRpc) {
  const result = await rpc.request("get_commands")
  if (!result || typeof result !== "object" || !("commands" in result) || !Array.isArray(result.commands)) {
    throw new TransportError("pi", "protocol", "Pi returned an invalid command list")
  }
  return result.commands.flatMap((value: unknown) => {
    if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string") {
      throw new TransportError("pi", "protocol", "Pi command has no name")
    }
    if (value.name === PI_TITLE_COMMAND) return []
    return [{ name: value.name, description: "description" in value && typeof value.description === "string" ? value.description : undefined }]
  })
}
