import type { GlobalBootstrapState } from "@/app/boot/data/bootstrap"
import { normalizeProjectList } from "@/platform/query/control-plane"

// RETAINED INSTRUMENTATION — do not delete individual marks. Consumer:
// `perf-harness/src/agent-claxedo-launcher.ts` reads marks WHOLESALE; see the
// full note in `app/entry/app.tsx`.
// `responseEnd` in Resource Timing finalizes when a fetch BODY IS CONSUMED, so a
// 1s "request" can really be a blocked main thread that could not run .json().
const perfDiag = (name: string, detail?: unknown) => { try { performance.mark(name, detail === undefined ? undefined : { detail }) } catch {} }

export type ShellBootstrap = {
  path: GlobalBootstrapState["path"]
  project: GlobalBootstrapState["project"]
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

export function shellBootstrapUrl(baseUrl: string) {
  const url = new URL("/api/claxedo/bootstrap", baseUrl)
  url.searchParams.set("scope", "shell")
  return url
}

export async function fetchShellBootstrap(input: {
  baseUrl: string
  request: typeof fetch
}): Promise<ShellBootstrap | undefined> {
  // `input.request(...)` is a METHOD call: it invokes the injected fetch with
  // `this === input`. A native `fetch` rejects that receiver, so passing the bare
  // builtin (which `GlobalSync` does) made this request fail before it reached the
  // network — silently, because of the `.catch` below — and the shell fell back to
  // the full bootstrap every single time. Call it as a plain function, the way
  // `sessionListRequest(...)(...)` already does, so any caller may pass `fetch`
  // itself. Unit tests cannot catch this with arrow/`Object.assign` stubs, which
  // ignore `this`; the regression test asserts the receiver directly.
  const request = input.request
  perfDiag("diag.shellBootstrap.fetchStart")
  const response = await request(shellBootstrapUrl(input.baseUrl), {
    headers: { Accept: "application/json" },
  }).catch((error: unknown) => {
    perfDiag("diag.shellBootstrap.fetchError", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    })
    return undefined
  })
  perfDiag("diag.shellBootstrap.headers", { ok: response?.ok ?? null, status: response?.status ?? null })
  if (!response?.ok) return
  perfDiag("diag.shellBootstrap.jsonStart")
  const body: unknown = await response.json().catch(() => undefined)
  perfDiag("diag.shellBootstrap.jsonDone", { bytes: isRecord(body) ? JSON.stringify(body).length : null })
  if (!isRecord(body) || body.healthy !== true || !isRecord(body.path) || !Array.isArray(body.project)) return
  return {
    path: body.path as GlobalBootstrapState["path"],
    project: body.project as GlobalBootstrapState["project"],
  }
}

export async function bootstrapInitialShell(input: {
  baseUrl: string
  request: typeof fetch
  setGlobalState: (patch: Partial<GlobalBootstrapState>) => void
  fallback: () => Promise<unknown>
}) {
  const shell = await fetchShellBootstrap(input)
  if (!shell) return input.fallback()
  input.setGlobalState({
    path: shell.path,
    project: normalizeProjectList(shell.project),
    ready: true,
  })
}
