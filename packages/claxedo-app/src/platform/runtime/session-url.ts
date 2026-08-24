import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { controlSessionUrl } from "@/platform/runtime/agent/workspace-control-routes"

type ResolveSessionUrlOptions = {
  cloudAutoSwitch?: boolean
  claxedoServerUrl?: string
  gatewayUrl?: string
  fetch?: typeof globalThis.fetch
}

function gatewayBody(input: unknown): { gatewayUrl?: unknown; harnessHost?: unknown } {
  if (!input || typeof input !== "object") return {}
  return {
    gatewayUrl: "gatewayUrl" in input ? input.gatewayUrl : undefined,
    harnessHost: "harnessHost" in input ? input.harnessHost : "runnerHost" in input ? input.runnerHost : undefined,
  }
}

export async function resolveSessionUrl(sessionId: string, options: ResolveSessionUrlOptions = {}) {
  if (options.cloudAutoSwitch === false) return null
  const base =
    normalizeUrl(options.claxedoServerUrl) ?? normalizeUrl(getClaxedoServerUrl()) ?? normalizeUrl(options.gatewayUrl)
  if (!base) return null

  const response = await (options.fetch ?? authFetch)(
    controlSessionUrl({
      baseUrl: base,
      sessionID: sessionId,
      suffix: "/gateway",
    }).toString(),
  ).catch(() => undefined)
  if (!response?.ok) return null

  const body = gatewayBody(await response.json().catch(() => undefined))
  if (body.harnessHost === "central") return base
  if (typeof body.gatewayUrl !== "string") return null
  return normalizeUrl(body.gatewayUrl) ?? null
}
