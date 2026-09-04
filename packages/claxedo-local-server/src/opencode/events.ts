/** OpenCode-shaped projection envelopes carried by Claxedo's event hub. */
export type OpencodeEvent = {
  directory?: string
  payload: { type?: string; properties?: Record<string, unknown> }
}

export type OpencodeEventsHandle = {
  on(fn: (e: OpencodeEvent) => void): void
  off(fn: (e: OpencodeEvent) => void): void
  start(): void
  close(): void
}
