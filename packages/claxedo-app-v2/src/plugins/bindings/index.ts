import type { PluginApi } from "@claxedo/plugin-api"
import type { ActivationScope } from "../activation"
import type { PluginBuild } from "../model"
import { actionBindings } from "./actions"
import { appearanceBindings } from "./appearance"
import { dataBindings } from "./data"
import { paneBindings } from "./panes"
import { regionBindings } from "./regions"
import { serverBinding } from "./server"
import type { BindingScope, HostServices } from "./services"
import { presentationBindings } from "./ui"

export { createOverlayTracker } from "./overlays"
export type { HostServices } from "./services"

export function createApiFactory(services: HostServices): (build: PluginBuild, activation: ActivationScope) => PluginApi {
  return (build, activation) => {
    const scope: BindingScope = { manifest: build.manifest, sink: activation.sink, signal: activation.signal, services }
    if (build.dictionary) activation.sink.track(services.i18n.add(build.dictionary))
    return {
      ...regionBindings(scope),
      ...paneBindings(scope),
      ...actionBindings(scope),
      ...appearanceBindings(scope),
      ...dataBindings(scope),
      server: serverBinding(scope),
      ...presentationBindings(scope),
    }
  }
}
