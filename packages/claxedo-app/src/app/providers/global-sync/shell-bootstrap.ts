import type { GlobalBootstrapState } from "@/app/boot/data/bootstrap"
import { normalizeProjectList } from "@/platform/query/control-plane"

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
  const response = await input.request(shellBootstrapUrl(input.baseUrl), {
    headers: { Accept: "application/json" },
  }).catch(() => undefined)
  if (!response?.ok) return
  const body: unknown = await response.json().catch(() => undefined)
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
