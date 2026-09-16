import fs from "node:fs/promises"
import path from "node:path"
import type { SessionTitleRequest } from "../../title-generation"
import type { PiRpcMessage } from "./rpc-process"

export const PI_TITLE_COMMAND = "claxedo-title"
const EXTENSION_FILE = "claxedo-session-title.ts"
const TITLE_REQUEST_TIMEOUT_MS = 45_000

/**
 * Pi has no title generation of its own, but its extension API has both
 * halves: a completion under the session's model and auth, and
 * `setSessionName`, which Pi persists and announces over RPC as
 * `session_info_changed`. An extension command runs immediately with no
 * transcript message and no agent turn (`AgentSession.prompt` executes
 * extension commands before anything else), so the side turn never reaches
 * the session's history.
 */
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

/** The extension file inside the Claxedo-owned Pi profile, rewritten only when its source changed. */
export async function ensurePiTitleExtension(agentDir: string) {
  const file = path.join(agentDir, EXTENSION_FILE)
  const current = await fs.readFile(file, "utf8").catch(() => null)
  if (current !== PI_TITLE_EXTENSION_SOURCE) await fs.writeFile(file, PI_TITLE_EXTENSION_SOURCE, { mode: 0o600 })
  return file
}

export type PiTitleProcess = {
  request(type: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  onEvent(listener: (event: PiRpcMessage) => void): () => void
}

/** The name the extension set during the command, read off the RPC stream rather than `get_state`, which would also return a `--name` given at create. */
export async function generatePiTitle(process: PiTitleProcess, request: SessionTitleRequest): Promise<string | null> {
  let name: string | null = null
  let failure: string | undefined
  const stop = process.onEvent((event) => {
    if (event.type === "session_info_changed" && typeof event.name === "string") name = event.name
    if (event.type === "extension_error" && event.extensionPath === `command:${PI_TITLE_COMMAND}`) failure = String(event.error)
  })
  try {
    await process.request("prompt", {
      message: `/${PI_TITLE_COMMAND} ${JSON.stringify({ system: request.system, user: request.user })}`,
    }, TITLE_REQUEST_TIMEOUT_MS)
    if (failure) throw new Error(failure)
    return name
  } finally {
    stop()
  }
}

export async function setPiSessionName(process: PiTitleProcess, title: string) {
  if (!title.trim()) return
  await process.request("set_session_name", { name: title })
}
