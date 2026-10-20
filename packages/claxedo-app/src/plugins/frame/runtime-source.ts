export type FrameRuntime = () => Promise<string>

export function createFrameRuntimeSource(): FrameRuntime {
  let loading: Promise<string> | undefined
  return () => {
    loading ??= import("virtual:claxedo-frame-runtime").then(
      (module) => module.default,
      (error: unknown) => {
        loading = undefined
        throw error
      },
    )
    return loading
  }
}
