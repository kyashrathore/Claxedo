export type RawHarnessEvent = {
  source: string
  method?: string
  payload: unknown
  receivedAt?: number
}

export function rawHarnessEvent(input: RawHarnessEvent): RawHarnessEvent {
  if (!input.source) throw new Error("RawHarnessEvent.source is required")
  return input
}
