import fs from "node:fs/promises"
import path from "node:path"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import { readTextIfExists, writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { readRecord, readString } from "@claxedo/helpers/readers"
import { TransportError } from "../../contract/errors"
import type { Deadline } from "../../contract"
import type { PiMessage, PiRpc } from "./rpc"

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

export type PiExtensionCommand = { what: string; command: string; extension: string; argument: string; deadline: Deadline }

async function assertRegistered(rpc: PiRpc, request: PiExtensionCommand): Promise<void> {
  const registered = await piRegisteredCommands(rpc, request.deadline)
  if (registered.some((entry) => entry.name === request.command && entry.source === "extension" && entry.path === request.extension)) return
  throw new TransportError("pi", "protocol", `${request.what} refused: Pi has not registered /${request.command} from ${request.extension}`)
}

export async function runPiExtensionCommand(rpc: PiRpc, request: PiExtensionCommand, observe: (event: PiMessage) => void = () => {}): Promise<void> {
  await assertRegistered(rpc, request)
  let failure: string | undefined
  const stop = rpc.onEvent((event) => {
    observe(event)
    if (event.type === "extension_error" && event.extensionPath === `command:${request.command}`) failure = String(event.error)
  })
  const { deadline } = request
  try {
    await settleAtRequestDeadline(request.what, { signal: deadline.signal, deadlineAt: deadline.at },
      rpc.request("prompt", { message: `/${request.command} ${request.argument}` }, Math.max(1, deadline.at - Date.now())),
      () => {}, (label, aborted) => new TransportError("pi", "timeout", `${label} ${aborted ? "was abandoned" : "timed out"}`))
    if (failure) throw new TransportError("pi", "protocol", failure)
  } finally { stop() }
}
