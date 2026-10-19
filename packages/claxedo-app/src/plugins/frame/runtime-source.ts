import frameRuntimeUrl from "./runtime/index.ts?worker&url"

export class FrameRuntimeError extends Error {
  constructor(readonly status: number) {
    super(`The plugin frame runtime could not be loaded (${status})`)
    this.name = "FrameRuntimeError"
  }
}

export type FrameRuntime = () => Promise<string>

export function createFrameRuntimeSource(): FrameRuntime {
  let loading: Promise<string> | undefined
  const load = async () => {
    const response = await fetch(frameRuntimeUrl)
    if (!response.ok) throw new FrameRuntimeError(response.status)
    return response.text()
  }
  return () => {
    loading ??= load().catch((error: unknown) => {
      loading = undefined
      throw error
    })
    return loading
  }
}
