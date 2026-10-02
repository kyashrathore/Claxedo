import type { SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import { TransportError } from "../../contract/errors"
import { installPiExtension, piExtensionPath, piRegisteredCommands } from "./extension"
import type { PiRpc } from "./rpc"

export const PI_TITLE_COMMAND = "claxedo-title"
const EXTENSION_FILE = "claxedo-session-title.ts"
const TITLE_REQUEST_TIMEOUT_MS = 45_000

const PI_TITLE_EXTENSION_SOURCE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

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

export async function piSessionTitle(rpc: PiRpc, stateRoot: string, request: SessionTitleRequest): Promise<string | null> {
  const deadline = { at: Date.now() + TITLE_REQUEST_TIMEOUT_MS, signal: request.signal }
  const extension = piExtensionPath(stateRoot, EXTENSION_FILE)
  const registered = await piRegisteredCommands(rpc, deadline)
  if (!registered.some((entry) => entry.name === PI_TITLE_COMMAND && entry.source === "extension" && entry.path === extension)) {
    throw new TransportError("pi", "protocol", `Pi title refused: Pi has not registered /${PI_TITLE_COMMAND} from ${extension}`)
  }
  let name: string | null = null
  let failure: string | undefined
  const stop = rpc.onMessage((event) => {
    if (event.type === "session_info_changed" && typeof event.name === "string") name = event.name
    if (event.type === "extension_error" && event.extensionPath === `command:${PI_TITLE_COMMAND}`) failure = String(event.error)
  })
  try {
    const argument = JSON.stringify({ system: request.system, user: request.user })
    await rpc.request("prompt", { message: `/${PI_TITLE_COMMAND} ${argument}` }, deadline)
    if (failure) throw new TransportError("pi", "protocol", failure)
    return name
  } finally { stop() }
}

export async function piCommands(rpc: PiRpc) {
  return (await piRegisteredCommands(rpc)).flatMap(({ name, description }) => name === PI_TITLE_COMMAND ? [] : [{ name, description }])
}
