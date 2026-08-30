import type { GlobalBootstrapState } from "@/app/boot/data/bootstrap"
import { normalizeProjectList } from "@/platform/query/control-plane"
import { accountRun } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"

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

function parseShellBootstrap(body: unknown): ShellBootstrap | undefined {
  if (!isRecord(body) || body.healthy !== true || !isRecord(body.path) || !Array.isArray(body.project)) return
  return {
    path: body.path as GlobalBootstrapState["path"],
    project: body.project as GlobalBootstrapState["project"],
  }
}

export async function fetchShellBootstrap(input: {
  baseUrl: string
  request: typeof fetch
}): Promise<ShellBootstrap | undefined> {
  const run = accountRun()
  // Desktop signed mode: shell bootstrap is account.get with scope=shell.
  if (run) {
    try {
      return parseShellBootstrap(
        decodeHostedResult("account.get", await run("account.get", { scope: "shell" })),
      )
    } catch {
      return
    }
  }
  const response = await input.request(shellBootstrapUrl(input.baseUrl), {
    headers: { Accept: "application/json" },
  }).catch(() => undefined)
  if (!response?.ok) return
  const body: unknown = await response.json().catch(() => undefined)
  return parseShellBootstrap(body)
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
