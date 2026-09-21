import { openInVerdict, type OpenInResolution } from "./open-in-guard"

/**
 * What `open-path` may do once the guard has spoken, each bound by `ipc.ts` to
 * its electron call. Injected so the refusal tests can prove that nothing was
 * launched rather than that a verdict object had the right shape.
 */
export type OpenInEffects = {
  reveal: (target: string) => void
  openWithOsHandler: (target: string) => Promise<void>
  /** Resolves true only when the user confirmed in a native dialog. */
  confirmOpenExecutable: (target: string) => Promise<boolean>
  launch: (app: string, target: string) => Promise<void>
}

export async function openIn(
  request: { path: string; app?: string },
  deps: OpenInResolution,
  effects: OpenInEffects,
): Promise<void> {
  const verdict = await openInVerdict(request, deps)
  // Thrown rather than dropped, for the reason `installIpcCallerGuard` gives:
  // a rejection reaches the renderer as a failed `invoke` with a stack.
  if (!verdict.allowed) throw new Error(`ipc "open-path" rejected: ${verdict.reason}`)
  const action = verdict.action
  switch (action.kind) {
    case "reveal":
      effects.reveal(action.path)
      return
    case "open-document":
      await effects.openWithOsHandler(action.path)
      return
    case "open-executable":
      if (await effects.confirmOpenExecutable(action.path)) await effects.openWithOsHandler(action.path)
      return
    case "launch":
      await effects.launch(action.app, action.path)
  }
}
