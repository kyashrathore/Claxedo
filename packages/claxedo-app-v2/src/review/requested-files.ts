import { createSignal, type Accessor } from "solid-js"

export const MAX_REQUESTED_FILES = 64

export function createRequestedFiles(scopeKey: Accessor<string>) {
  const [requested, setRequested] = createSignal<{ readonly key: string; readonly files: readonly string[] }>({
    key: "",
    files: [],
  })
  const files = () => (requested().key === scopeKey() ? requested().files : [])
  const request = (next: readonly string[]) => {
    const current = files()
    const merged = [...new Set([...next, ...current])].slice(0, MAX_REQUESTED_FILES)
    if (merged.length === current.length && merged.every((file, index) => file === current[index])) return
    setRequested({ key: scopeKey(), files: merged })
  }
  return { files, request }
}
