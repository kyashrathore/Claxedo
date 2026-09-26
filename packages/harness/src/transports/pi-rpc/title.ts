import fs from "node:fs/promises"
import path from "node:path"
import type { SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import { settleAtRequestDeadline } from "@claxedo/helpers"
import { writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { TransportError } from "../../contract/errors"
import type { PiRpc } from "./rpc"

export const PI_TITLE_COMMAND = "claxedo-title"
const EXTENSION_FILE = "claxedo-session-title.ts"
const TITLE_REQUEST_TIMEOUT_MS = 45_000

export const PI_TITLE_EXTENSION_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.registerCommand(${JSON.stringify(PI_TITLE_COMMAND)}, {
    description: "Name this session from its first exchange (Claxedo)",
    handler: async (args, ctx) => {
      const model = ctx.model
      if (!model || !args.trim()) return
      const { system, user } = JSON.parse(args) as { system: string; user: string }
      const reply = await ctx.modelRegistry.complete(model, {
        systemPrompt: system,
        messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
      }, { cacheRetention: "none" })
      if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "title completion failed")
      const text = reply.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\\n")
      const title = text
        .split("\\n")
        .map((line) => line.trim().replace(/^["'\`]+|["'\`]+$/g, "").trim())
        .find((line) => line.length > 0)
      if (title) pi.setSessionName(title)
    },
  })
}
`

export function piTitleExtensionPath(stateRoot: string): string {
  return path.join(stateRoot, "extensions", EXTENSION_FILE)
}

export async function installPiTitleExtension(stateRoot: string): Promise<string> {
  const file = piTitleExtensionPath(stateRoot)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  let current: string | undefined
  try { current = await fs.readFile(file, "utf8") }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error }
  if (current !== PI_TITLE_EXTENSION_SOURCE) await writePrivateFileAtomic(file, PI_TITLE_EXTENSION_SOURCE)
  return file
}

export async function piSessionTitle(rpc: PiRpc, request: SessionTitleRequest): Promise<string | null> {
  let name: string | null = null
  let failure: string | undefined
  const stop = rpc.onEvent((event) => {
    if (event.type === "session_info_changed" && typeof event.name === "string") name = event.name
    if (event.type === "extension_error" && event.extensionPath === `command:${PI_TITLE_COMMAND}`) failure = String(event.error)
  })
  try {
    await settleAtRequestDeadline("Pi title", { signal: request.signal, deadlineAt: Date.now() + TITLE_REQUEST_TIMEOUT_MS },
      rpc.request("prompt", { message: `/${PI_TITLE_COMMAND} ${JSON.stringify({ system: request.system, user: request.user })}` }, TITLE_REQUEST_TIMEOUT_MS),
      () => {}, (what, aborted) => new TransportError("pi", "timeout", `${what} ${aborted ? "was abandoned" : "timed out"}`))
    if (failure) throw new TransportError("pi", "protocol", failure)
    return name
  } finally { stop() }
}
