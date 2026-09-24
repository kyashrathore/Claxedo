import type { PluginApi } from "@claxedo/plugin-api"
import { PluginEntryError, type BindingScope } from "./services"

type Appearance = Pick<PluginApi, "themes" | "icons">

export function appearanceBindings(scope: BindingScope): Appearance {
  const { registries } = scope.services
  const refuseTaken = (kind: string, taken: boolean, id: string) => {
    if (taken) throw new PluginEntryError(scope.manifest.id, `the ${kind} id ${id} is already registered`)
  }
  return {
    themes: {
      register: (theme) => {
        refuseTaken("theme", registries.themes.list().some((entry) => entry.id === theme.id), theme.id)
        return scope.sink.add(registries.themes, { id: theme.id, name: theme.name, appearance: theme.appearance, tokens: theme.tokens })
      },
    },
    icons: {
      registerSkin: (skin) => {
        refuseTaken("icon skin", registries.iconSkins.list().some((entry) => entry.id === skin.id), skin.id)
        return scope.sink.add(registries.iconSkins, { id: skin.id, icons: skin.icons })
      },
    },
  }
}
