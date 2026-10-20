export type SubmitKeyEvent = {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly isComposing: boolean
}

export type SubmitKeys = "line" | "text" | "title"

export function isSubmitKey(event: SubmitKeyEvent, keys: SubmitKeys): boolean {
  if (event.isComposing || event.altKey) return false
  const mod = event.metaKey || event.ctrlKey
  const save = mod && event.key.toLowerCase() === "s"
  if (keys === "text") return save || (mod && event.key === "Enter")
  const enter = event.key === "Enter" && !mod && !event.shiftKey
  return keys === "title" ? enter || save : enter
}
