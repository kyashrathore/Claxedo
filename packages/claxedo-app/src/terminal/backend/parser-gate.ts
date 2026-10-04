type WriteFn = (data: string | Uint8Array, callback?: () => void) => void

export type ParserGate = {
  pending: number
  queued: (() => void) | null
}

export function createParserGate(): ParserGate {
  return { pending: 0, queued: null }
}

export function cancelParserIdleWork(gate: ParserGate): void {
  gate.queued = null
}

function flushQueued(gate: ParserGate): void {
  if (gate.pending !== 0) return
  const fn = gate.queued
  if (!fn) return
  gate.queued = null
  fn()
}

export function gatedWrite(gate: ParserGate, write: WriteFn): WriteFn {
  return (data, callback) => {
    gate.pending += 1
    write(data, () => {
      try {
        callback?.()
      } finally {
        gate.pending -= 1
        if (gate.pending === 0 && gate.queued) queueMicrotask(() => flushQueued(gate))
      }
    })
  }
}

export function runWhenParserIdle(gate: ParserGate, fn: () => void): void {
  if (gate.pending === 0) {
    fn()
    return
  }
  gate.queued = fn
}
