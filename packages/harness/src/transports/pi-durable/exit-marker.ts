export type ExitMarker = { readonly text: string; readonly code: Promise<number>; filter(chunk: string): string }

function heldBack(pending: string, marker: string): number {
  for (let length = Math.min(pending.length, marker.length - 1); length > 0; length--) {
    if (marker.startsWith(pending.slice(-length))) return length
  }
  return 0
}

export function exitMarker(): ExitMarker {
  const text = `pi-exit-${crypto.randomUUID()}:`
  const { promise: code, resolve } = Promise.withResolvers<number>()
  let pending = ""
  let found = false
  return {
    text, code,
    filter(chunk) {
      if (found) return chunk
      pending += chunk
      const at = pending.indexOf(text)
      const end = at < 0 ? -1 : pending.indexOf("\n", at)
      if (at >= 0 && end < 0) return ""
      if (at >= 0) {
        found = true
        resolve(Number(pending.slice(at + text.length, end)))
        const shown = pending.slice(0, at) + pending.slice(end + 1)
        pending = ""
        return shown
      }
      const keep = heldBack(pending, text)
      const shown = pending.slice(0, pending.length - keep)
      pending = pending.slice(pending.length - keep)
      return shown
    },
  }
}
