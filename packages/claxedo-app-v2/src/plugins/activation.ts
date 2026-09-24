import { catchError, createRoot } from "solid-js"
import type { PluginApi } from "@claxedo/plugin-api"
import { failureReason } from "./failure"
import { buildIdOf, type PluginBuild } from "./model"
import { createRegistrationSink, type RegistrationSink } from "./registrations"

export type Activation = { readonly build: string; readonly dispose: () => void }

export type ActivationScope = { readonly sink: RegistrationSink; readonly signal: AbortSignal }

export type ActivationInput = {
  readonly build: PluginBuild
  readonly buildApi: (build: PluginBuild, scope: ActivationScope) => PluginApi
  readonly onCrash: (reason: string) => void
}

export function activatePlugin(input: ActivationInput): Promise<Activation> {
  const sink = createRegistrationSink(input.build.manifest.id)
  const abort = new AbortController()
  return new Promise((resolve, reject) => {
    createRoot((disposeRoot) => {
      let settled = false
      const dispose = () => {
        abort.abort()
        sink.disposeAll()
        disposeRoot()
      }
      const fail = (error: unknown) => {
        if (settled) return input.onCrash(failureReason(error))
        settled = true
        dispose()
        reject(error)
      }
      const succeed = (cleanup: unknown) => {
        if (settled) return
        settled = true
        if (typeof cleanup === "function") sink.track(() => cleanup())
        resolve({ build: buildIdOf(input.build), dispose })
      }
      catchError(() => {
        const api = input.buildApi(input.build, { sink, signal: abort.signal })
        Promise.resolve(input.build.definition.activate(api)).then(succeed, fail)
      }, fail)
    })
  })
}
