import { catchError, createRoot } from "solid-js"
import type { PluginApi, PluginModule } from "@claxedo/plugin-api"
import { failureReason } from "./boundary"
import { createRegistrationSink, type RegistrationSink } from "./registrations"

export type Activation = { readonly version: string; readonly dispose: () => void }

export type ActivationInput = {
  readonly module: PluginModule
  readonly buildApi: (sink: RegistrationSink) => PluginApi
  readonly onLateFailure: (reason: string) => void
}

export function activatePlugin(input: ActivationInput): Promise<Activation> {
  const sink = createRegistrationSink()
  return new Promise((resolve, reject) => {
    createRoot((dispose) => {
      let settled = false
      const teardown = () => {
        sink.disposeAll()
        dispose()
      }
      const fail = (error: unknown) => {
        if (settled) {
          input.onLateFailure(failureReason(error))
          return
        }
        settled = true
        teardown()
        reject(error)
      }
      const succeed = () => {
        if (settled) return
        settled = true
        resolve({ version: input.module.manifest.version, dispose: teardown })
      }
      catchError(() => {
        const api = input.buildApi(sink)
        Promise.resolve(input.module.activate(api)).then(succeed, fail)
      }, fail)
    })
  })
}
