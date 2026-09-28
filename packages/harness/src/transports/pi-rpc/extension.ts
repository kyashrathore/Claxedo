import fs from "node:fs/promises"
import path from "node:path"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import { readTextIfExists, writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { TransportError } from "../../contract/errors"
import type { Deadline } from "../../contract"
import type { PiMessage, PiRpc } from "./rpc"

export function piExtensionPath(stateRoot: string, file: string): string {
  return path.join(stateRoot, "extensions", file)
}

export async function installPiExtension(stateRoot: string, file: string, source: string): Promise<string> {
  const target = piExtensionPath(stateRoot, file)
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  if (await readTextIfExists(target) !== source) await writePrivateFileAtomic(target, source)
  return target
}

export async function runPiExtensionCommand(rpc: PiRpc, what: string, command: string, argument: string,
  deadline: Deadline, observe: (event: PiMessage) => void = () => {}): Promise<void> {
  let failure: string | undefined
  const stop = rpc.onEvent((event) => {
    observe(event)
    if (event.type === "extension_error" && event.extensionPath === `command:${command}`) failure = String(event.error)
  })
  try {
    await settleAtRequestDeadline(what, { signal: deadline.signal, deadlineAt: deadline.at },
      rpc.request("prompt", { message: `/${command} ${argument}` }, Math.max(1, deadline.at - Date.now())),
      () => {}, (label, aborted) => new TransportError("pi", "timeout", `${label} ${aborted ? "was abandoned" : "timed out"}`))
    if (failure) throw new TransportError("pi", "protocol", failure)
  } finally { stop() }
}
