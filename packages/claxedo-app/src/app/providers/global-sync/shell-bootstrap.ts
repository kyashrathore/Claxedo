import type { GlobalBootstrapState } from "@/app/boot/data/bootstrap"
import { isRecord, readString } from "@/lib/record"

export type ShellBootstrap = {
  path: GlobalBootstrapState["path"]
}

export function shellBootstrapUrl(baseUrl: string) {
  const url = new URL("/api/claxedo/bootstrap", baseUrl)
  url.searchParams.set("scope", "shell")
  return url
}

function parseShellBootstrap(body: unknown): ShellBootstrap | undefined {
  if (!isRecord(body) || body.healthy !== true) return undefined
  const path = body.path
  if (!isRecord(path)) return undefined
  // `ClaxedoPath` is five directory strings. Reading them by name is what the
  // assertion used to claim without checking; a field the server omits reads
  // as empty rather than as an `undefined` the declared type forbids.
  const directory = (key: string) => readString(path, key) ?? ""
  return {
    path: {
      home: directory("home"),
      state: directory("state"),
      config: directory("config"),
      worktree: directory("worktree"),
      directory: directory("directory"),
    },
  }
}

export async function fetchShellBootstrap(input: {
  baseUrl: string
  request: typeof fetch
}): Promise<ShellBootstrap | undefined> {
  const response = await input.request(shellBootstrapUrl(input.baseUrl), {
    headers: { Accept: "application/json" },
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const body: unknown = await response.json().catch(() => undefined)
  return parseShellBootstrap(body)
}

/**
 * The daemon's one-call shell warmup: the paths the first paint needs, before
 * the full bootstrap runs. It seeds no catalog — the workspace catalog is its
 * own query (`features/workspaces/data/workspace-catalog.ts`) and reads the
 * daemon's `/project` plus the control plane itself.
 */
export async function bootstrapInitialShell(input: {
  baseUrl: string
  request: typeof fetch
  setGlobalState: (patch: Partial<GlobalBootstrapState>) => void
  fallback: () => Promise<unknown>
}) {
  const shell = await fetchShellBootstrap(input)
  if (!shell) return input.fallback()
  input.setGlobalState({ path: shell.path, ready: true })
  return undefined
}
