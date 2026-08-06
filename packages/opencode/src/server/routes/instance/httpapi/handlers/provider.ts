import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://opencode.local")
      const selectedProvider = url.searchParams.get("provider")
      const indexOnly = url.searchParams.get("view") === "index"
      const config = yield* cfg.get()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered = Object.fromEntries(
        Object.entries(all).filter(([key]) => (enabled ? enabled.has(key) : true) && !disabled.has(key)),
      )
      const connected = yield* provider.list()
      const connectedIDs = Object.keys(connected)
      if (indexOnly) {
        const defaults = Provider.defaultModelIDs(connected)
        const providers = new Map(
          Object.entries(filtered).map(([id, item]) => [id, { id, name: item.name }] as const),
        )
        Object.entries(connected).forEach(([id, item]) => providers.set(id, { id, name: item.name }))
        return {
          all: [...providers.values()].map((item) => {
            const connectedProvider = connected[ProviderV2.ID.make(item.id)]
            const defaultModel = defaults[item.id]
            return {
              id: ProviderV2.ID.make(item.id),
              name: item.name,
              source: connectedProvider?.source ?? "custom" as const,
              env: [],
              options: {},
              models: connectedProvider && defaultModel && connectedProvider.models[defaultModel]
                ? { [defaultModel]: Provider.toPublicInfo(connectedProvider).models[defaultModel]! }
                : {},
            }
          }),
          default: defaults,
          connected: connectedIDs,
        }
      }
      if (selectedProvider) {
        const id = ProviderV2.ID.make(selectedProvider)
        const selected = connected[id] ?? (filtered[selectedProvider] ? Provider.fromModelsDevProvider(filtered[selectedProvider]) : undefined)
        return {
          all: selected ? [Provider.toPublicInfo(selected)] : [],
          default: Provider.defaultModelIDs({ ...connected, ...(selected ? { [id]: selected } : {}) }),
          connected: connectedIDs,
        }
      }
      const providers = Object.assign(
        mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        connected,
      )
      const defaults = Provider.defaultModelIDs(providers)
      return {
        all: Object.values(providers).map(Provider.toPublicInfo),
        default: defaults,
        connected: connectedIDs,
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
