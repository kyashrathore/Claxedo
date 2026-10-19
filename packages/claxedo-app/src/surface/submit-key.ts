export type SubmitKeyEvent = {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly isComposing: boolean
}

export function isSubmitKey(event: SubmitKeyEvent, longText: boolean): boolean {
  if (event.isComposing || event.altKey) return false
  const mod = event.metaKey || event.ctrlKey
  if (longText) return mod && (event.key === "Enter" || event.key.toLowerCase() === "s")
  return event.key === "Enter" && !mod && !event.shiftKey
}
