import type { Plugin } from "@opencode-ai/plugin"

export type PluginEventWatch = Readonly<{ close(): Promise<void> }>

export function watchPluginEvents(context: Plugin.Context, accepts: (type: string) => boolean,
  handle: (event: { type: string; data: unknown }) => Promise<void>, failure: string): PluginEventWatch {
  let open = true
  const events = context.event.subscribe()[Symbol.asyncIterator]()
  const reading = (async () => {
    for (let next = await events.next(); !next.done; next = await events.next()) {
      if (!open) return
      if (accepts(next.value.type)) await handle(next.value)
    }
  })()
  void reading.catch((error: unknown) => console.error(failure, error))
  return {
    async close() {
      open = false
      await events.return?.()
      await reading.catch((error: unknown) => console.error(failure, error))
    },
  }
}
