import {
  disabledProviders,
  ProviderConfigRoutes,
} from "../../../../workspace-runtime/src/routes/provider-config"
import { WorkspaceRuntimeRoutes } from "../../../../workspace-runtime/src/routes/manifest"

export type DrivenProviderConfigResponse = {
  status: number
  body: unknown
}

/**
 * Drive the real workspace-runtime provider-config router over an in-memory
 * configuration document.
 *
 * Provider configuration belongs to (a workspace, a harness), so the mock holds
 * one document per installed runtime and answers a disconnect exactly as the
 * runtime does — including the 404 for a harness that declares no providers.
 * `disabled()` is the same list the engine filters its connected catalog by, so
 * a `/provider` stub can be derived from it rather than from a second fixture.
 */
export function createRuntimeProviderConfig(input: {
  /** The harness whose configuration this runtime holds, read per request. */
  harness: () => string
  /** The document it starts from. */
  config?: Record<string, unknown>
}) {
  let document: Record<string, unknown> = { ...(input.config ?? {}) }
  const requests: Array<{ harness: string; directory: string | null; body: unknown }> = []
  const app = ProviderConfigRoutes({
    defaultHarness: input.harness,
    store: async (harness) =>
      harness === input.harness()
        ? {
            read: async () => ({ ...document }),
            write: async (patch) => {
              document = { ...document, ...patch }
              return { ...document }
            },
          }
        : undefined,
  })

  return {
    /** The providers this runtime's configuration currently disables. */
    disabled: () => disabledProviders(document),
    /** Every write the app asked for, in order, with the scope it named. */
    requests,
    /**
     * Answer one `PATCH /api/wr/provider-config` however it was addressed —
     * loopback (`/api/wr/...`) or through the relay
     * (`/workspaces/:id/api/wr/...`).
     */
    async handle(request: { url: string; method: string; body: string | null }): Promise<DrivenProviderConfigResponse> {
      const incoming = new URL(request.url)
      const marker = WorkspaceRuntimeRoutes.providerConfig
      if (!incoming.pathname.endsWith(marker)) {
        throw new Error(`Not a workspace-runtime provider-config URL: ${request.url}`)
      }
      const driven = new URL(marker, "http://mock-runtime")
      driven.search = incoming.search
      requests.push({
        harness: incoming.searchParams.get("harness") ?? input.harness(),
        directory: incoming.searchParams.get("directory"),
        body: request.body ? JSON.parse(request.body) as unknown : null,
      })
      const response = await app.request(driven, {
        method: request.method,
        headers: { "content-type": "application/json" },
        ...(request.body === null ? {} : { body: request.body }),
      })
      return { status: response.status, body: await response.json() }
    },
  }
}

export type RuntimeProviderConfig = ReturnType<typeof createRuntimeProviderConfig>
