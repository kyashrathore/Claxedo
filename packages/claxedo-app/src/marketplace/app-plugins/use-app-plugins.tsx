import { createMemo, type JSX } from "solid-js"
import type { createSelection } from "../directory-state"
import { createAppPluginActions } from "./actions"
import { AppPluginDetails } from "./details"
import { createAppPluginDirectory } from "./directory"
import { AppPluginsSection } from "./section"

export function useAppPlugins(input: { readonly query: () => string; readonly selection: ReturnType<typeof createSelection> }) {
  const directory = createAppPluginDirectory(input.query)
  const actions = createAppPluginActions()
  const selected = () => directory.find(input.selection.selectedAppId())
  const shown = createMemo(() => selected() !== undefined)
  const panel = createMemo(() => {
    if (!shown()) return undefined
    return {
      get name() {
        return selected()?.name ?? ""
      },
      details: (): JSX.Element => {
        const entry = selected()
        return entry ? <AppPluginDetails entry={selected() ?? entry} canManage={directory.canManage()} actions={actions} /> : undefined
      },
    }
  })
  const section = (): JSX.Element =>
    directory.offered ? (
      <AppPluginsSection directory={directory} actions={actions} selectedId={input.selection.selectedAppId()} onOpen={input.selection.openAppPlugin} />
    ) : undefined
  return { panel, section, count: () => (directory.offered ? directory.visible().length : 0) }
}
