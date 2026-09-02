import type { GlobalBootstrapState } from "@/app/boot/data/bootstrap"

export type ShellBootstrap = {
  path: GlobalBootstrapState["path"]
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

export function shellBootstrapUrl(baseUrl: string) {
  const url = new URL("/api/claxedo/bootstrap", baseUrl)
  url.searchParams.set("scope", "shell")
  return url
}

function parseShellBootstrap(body: unknown): ShellBootstrap | undefined {
  if (!isRecord(body) || body.healthy !== true || !isRecord(body.path)) return
  return { path: body.path as GlobalBootstrapState["path"] }
}

export async function fetchShellBootstrap(input: {
  baseUrl: string
  request: typeof fetch
}): Promise<ShellBootstrap | undefined> {
  const response = await input.request(shellBootstrapUrl(input.baseUrl), {
    headers: { Accept: "application/json" },
  }).catch(() => undefined)
  if (!response?.ok) return
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
}
