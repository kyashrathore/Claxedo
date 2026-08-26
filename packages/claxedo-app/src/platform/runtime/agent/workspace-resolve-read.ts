/**
 * Single-flight registry for the workspace-resolve route.
 *
 * WHY AN OWNED INSTANCE RATHER THAN A MODULE-SCOPE MAP: the in-flight set is
 * per-runtime state, not ambient state. Module scope would leak it across
 * runtimes in tests and across windows in any future multi-window case, and it
 * would have no dispose point. This mirrors how `queryClient` is owned here — a
 * constructed instance with a lifecycle, exported once. `createHttpWorkspace
 * RuntimeBackend` is built per call site, so the registry cannot live on the
 * backend either: a per-backend map would dedupe nothing, because the duplicate
 * resolves come from different backends.
 *
 * SEMANTICS. The shared window is exactly the in-flight window: the entry is
 * deleted when the request settles, so a caller reading AFTER a write issues a
 * real request and observes the new value. Sharing can only merge reads already
 * in flight; it can never serve a retained snapshot. A `create=true` resolve is
 * a WRITE and is never shared.
 *
 * FAILURES ARE SHARED AS FAILURES. An earlier version of this reader returned
 * `body: undefined` for a non-ok response, which silently replaced `readJson`'s
 * throw with an undefined snapshot that callers then read `.kind` off. The
 * outcome — value or thrown error — is captured once and replayed to every
 * joiner, so sharing changes WHO issues the request and nothing else.
 */
export type WorkspaceResolveOutcome = {
  ok: boolean
  status: number
  /** Replays exactly what a direct `readJson(response)` would have done. */
  valueOrThrow: () => unknown
}

export function shareableResolve(input: { create?: boolean }) {
  return input.create !== true
}

export function createWorkspaceResolveRegistry() {
  const inFlight = new Map<string, Promise<WorkspaceResolveOutcome>>()

  async function request(input: { url: string; request: typeof fetch }): Promise<WorkspaceResolveOutcome> {
    const response = await input.request(input.url, { headers: { Accept: "application/json" } })
    const status = response.status
    const ok = response.ok
    const text = await response.text()
    if (!ok) {
      const message = text || `Request failed: ${status}`
      return { ok, status, valueOrThrow: () => { throw new Error(message) } }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok, status, valueOrThrow: () => { throw new Error("Workspace runtime is unavailable.") } }
    }
    return { ok, status, valueOrThrow: () => parsed }
  }

  return {
    read(input: { url: string; request: typeof fetch; create?: boolean }): Promise<WorkspaceResolveOutcome> {
      if (!shareableResolve(input)) return request(input)
      const existing = inFlight.get(input.url)
      if (existing) return existing
      const pending = request(input).finally(() => {
        if (inFlight.get(input.url) === pending) inFlight.delete(input.url)
      })
      inFlight.set(input.url, pending)
      return pending
    },
  }
}

export const workspaceResolveRegistry = createWorkspaceResolveRegistry()

export function resolveWorkspaceRead(input: {
  url: string
  request: typeof fetch
  create?: boolean
}): Promise<WorkspaceResolveOutcome> {
  return workspaceResolveRegistry.read(input)
}
