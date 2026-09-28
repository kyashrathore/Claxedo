import type { SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import { installPiExtension, runPiExtensionCommand } from "./extension"
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

export function installPiTitleExtension(stateRoot: string): Promise<string> {
  return installPiExtension(stateRoot, EXTENSION_FILE, PI_TITLE_EXTENSION_SOURCE)
}

export async function piSessionTitle(rpc: PiRpc, request: SessionTitleRequest): Promise<string | null> {
  let name: string | null = null
  await runPiExtensionCommand(rpc, "Pi title", PI_TITLE_COMMAND, JSON.stringify({ system: request.system, user: request.user }),
    { at: Date.now() + TITLE_REQUEST_TIMEOUT_MS, signal: request.signal }, (event) => {
      if (event.type === "session_info_changed" && typeof event.name === "string") name = event.name
    })
  return name
}
