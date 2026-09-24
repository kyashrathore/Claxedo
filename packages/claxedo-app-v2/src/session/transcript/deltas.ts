export type DeltaFlush = (messageId: string, partId: string, field: string, text: string) => void

export type DeltaBuffer = {
  readonly add: (messageId: string, partId: string, field: string, delta: string) => void
  readonly flush: () => void
  readonly drop: () => void
}

type BufferedDelta = { readonly messageId: string; readonly partId: string; readonly field: string; text: string }

export function createDeltaBuffer(flush: DeltaFlush): DeltaBuffer {
  const buffered = new Map<string, BufferedDelta>()
  const frame = { handle: undefined as number | undefined }

  function cancelFrame(): void {
    if (frame.handle === undefined) return
    cancelAnimationFrame(frame.handle)
    frame.handle = undefined
  }

  function flushAll(): void {
    cancelFrame()
    const items = [...buffered.values()]
    buffered.clear()
    for (const item of items) flush(item.messageId, item.partId, item.field, item.text)
  }

  return {
    add(messageId, partId, field, delta) {
      const key = `${messageId}\u0000${partId}\u0000${field}`
      const current = buffered.get(key)
      if (current) current.text += delta
      else buffered.set(key, { messageId, partId, field, text: delta })
      if (frame.handle === undefined) frame.handle = requestAnimationFrame(flushAll)
    },
    flush: flushAll,
    drop() {
      cancelFrame()
      buffered.clear()
    },
  }
}
