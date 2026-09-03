import { Hono } from "hono"
import { boundedJsonBody, errorBody, harnessQueryParam, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { WorkspaceRuntimeRoutes } from "./manifest"

/**
 * The provider configuration of ONE harness inside this workspace.
 *
 * A provider row can be connected in two different ways, and only one of them
 * has a credential behind it. An `api`-sourced row is a stored key, dropped
 * with `DELETE /auth/:providerID`. A `config`-sourced row exists because the
 * harness's own config DECLARES it, so there is no credential to remove — the
 * only way to disconnect it is to name it in that config's `disabled_providers`.
 *
 * That config belongs to (this workspace, that harness): two machines running
 * the same harness declare different providers, so the document is the
 * workspace runtime's and the write half lives here, next to the `GET /provider`
 * read that answers from it.
 */
export type ProviderConfigStore = {
  /** The harness's current configuration document. */
  read(): Promise<Record<string, unknown>>
  /**
   * Merge `patch` into it and settle whatever caches the catalog is derived
   * from, so the next `GET /provider` reflects the new list.
   */
  write(patch: { disabled_providers: string[] }): Promise<Record<string, unknown>>
}

export type ProviderConfigRouteOptions = {
  /**
   * The store for one harness, or `undefined` when that harness declares no
   * providers in this workspace and therefore has nothing to disable.
   */
  store: (harnessId: string) => Promise<ProviderConfigStore | undefined>
  /** The harness a request that names none is about. */
  defaultHarness: () => string
}

/** The `disabled_providers` list a configuration document carries, if any. */
export function disabledProviders(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return []
  const value = (config as { disabled_providers?: unknown }).disabled_providers
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

/**
 * The list one provider must end up in (or out of).
 *
 * Order-stable and deduplicated so repeating the same disconnect writes the
 * same document — the config merge that applies it replaces the whole array.
 */
export function nextDisabledProviders(
  current: readonly string[],
  input: { provider: string; disabled: boolean },
): string[] {
  const without = current.filter((item) => item !== input.provider)
  return input.disabled ? [...without, input.provider] : without
}

type ProviderDisableRequest = { provider: string; disabled: boolean }

function providerDisableRequest(input: unknown): ProviderDisableRequest | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const body = input as { provider?: unknown; disabled?: unknown }
  if (typeof body.provider !== "string" || !body.provider.trim()) return
  if (typeof body.disabled !== "boolean") return
  return { provider: body.provider.trim(), disabled: body.disabled }
}

function failureMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * `PATCH /api/wr/provider-config?harness=<id>` — disable or re-enable ONE
 * provider in this workspace's configuration for that harness.
 *
 * Body: `{"provider": "<id>", "disabled": true|false}`.
 * Answer: `{"harness": "<id>", "disabled_providers": [...]}` — the resulting
 * list, so a caller can reconcile a cached catalog without a second read.
 *
 * `?directory=` is carried by callers for the dispatcher that routes a request
 * to the runtime serving a workspace; this route is already inside that
 * workspace and does not read it.
 */
export const ProviderConfigRoutes = (options: ProviderConfigRouteOptions) =>
  new Hono()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      throw err
    })
    .patch(WorkspaceRuntimeRoutes.providerConfig, async (c) => {
      const harness = harnessQueryParam(c.req) || options.defaultHarness()
      const body = providerDisableRequest(await boundedJsonBody<unknown>(c, null))
      if (!body) {
        return c.json(
          errorBody(
            "provider_config_invalid_request",
            "Body must be {\"provider\": string, \"disabled\": boolean}",
          ),
          400,
        )
      }
      try {
        const store = await options.store(harness)
        if (!store) {
          return c.json(
            errorBody(
              "provider_config_unsupported_harness",
              `${harness} declares no providers in this workspace's configuration`,
            ),
            404,
          )
        }
        const current = disabledProviders(await store.read())
        const written = await store.write({ disabled_providers: nextDisabledProviders(current, body) })
        return c.json({ harness, disabled_providers: disabledProviders(written) })
      } catch (cause) {
        return c.json(errorBody("provider_config_unavailable", failureMessage(cause)), 502)
      }
    })
