import { createMemo, onCleanup, type JSX } from "solid-js"
import type { SurfaceChannel, SurfaceProgram } from "@claxedo/plugin-api"
import { AgentConfigurationPicker } from "@/composer"
import { uuid } from "@/lib/uuid"
import { createSurface, SurfaceReferencesProvider, SurfaceView, type SurfaceReferences } from "@/surface"
import { TranscriptKitProviders } from "@/transcript"
import { openPluginSurface, type SurfacePageController } from "./controller"

const PLUGIN_REFERENCES: SurfaceReferences = { AgentConfigurationPicker }

export type PluginSurfaceProps = {
  readonly pluginName: string
  readonly label: string
  readonly open: (channel: SurfaceChannel) => SurfaceProgram | void
}

export function PluginSurface(props: PluginSurfaceProps & { readonly opened?: (controller: SurfacePageController) => void }): JSX.Element {
  const surface = createSurface(uuid())
  const controller = openPluginSurface({ surface, label: props.label, open: props.open })
  props.opened?.(controller)
  onCleanup(controller.close)
  const failure = createMemo(() => {
    const state = controller.state()
    if (state.kind === "failed") throw state.error
  })
  return (
    <>
      {failure()}
      <TranscriptKitProviders>
        <SurfaceReferencesProvider value={PLUGIN_REFERENCES}>
          <SurfaceView surface={surface} source={{ kind: "plugin", label: props.pluginName }} placement="page" onAction={controller.action} />
        </SurfaceReferencesProvider>
      </TranscriptKitProviders>
    </>
  )
}
