import type { FoundMention, FrameInvoke } from "../protocol"
import type { FrameEntries } from "./api"
import type { FrameSurfaces } from "./surfaces"

export async function answerInvoke(entries: FrameEntries, surfaces: FrameSurfaces, invoke: FrameInvoke): Promise<unknown> {
  if (invoke.method === "surface.open" || invoke.method === "surface.action" || invoke.method === "surface.close") return surfaces.answer(invoke)
  if (invoke.method === "command.run") {
    const command = entries.commands.get(invoke.commandId)
    if (!command) throw new Error(`No command ${invoke.commandId} is registered`)
    return command.run(invoke.context)
  }
  const provider = entries.mentions.get(invoke.mentionId)
  if (!provider) throw new Error(`No mention provider ${invoke.mentionId} is registered`)
  const items = await provider.search(invoke.query, invoke.context)
  return items.map((item): FoundMention => ({ item, insert: provider.insert(item) }))
}
