import fs from "node:fs/promises"
import path from "node:path"
import { readTextIfExists, writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { readRecord, readString } from "@claxedo/helpers/readers"
import { TransportError } from "../../contract/errors"
import type { Deadline } from "../../contract"
import type { PiRpc } from "./rpc"

export type PiRegisteredCommand = { name: string; description?: string; source?: string; path?: string }

export function piExtensionPath(stateRoot: string, file: string): string {
  return path.join(stateRoot, "extensions", file)
}

export async function installPiExtension(stateRoot: string, file: string, source: string): Promise<string> {
  const target = piExtensionPath(stateRoot, file)
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  if (await readTextIfExists(target) !== source) await writePrivateFileAtomic(target, source)
  return target
}

export async function piRegisteredCommands(rpc: PiRpc, limit?: Deadline): Promise<PiRegisteredCommand[]> {
  const result = await rpc.request("get_commands", {}, limit)
  if (!result || typeof result !== "object" || !("commands" in result) || !Array.isArray(result.commands)) {
    throw new TransportError("pi", "protocol", "Pi returned an invalid command list")
  }
  return result.commands.map((value: unknown) => {
    const name = readString(value, "name")
    if (name === undefined) throw new TransportError("pi", "protocol", "Pi command has no name")
    return { name, description: readString(value, "description"), source: readString(value, "source"),
      path: readString(readRecord(value, "sourceInfo"), "path") }
  })
}
