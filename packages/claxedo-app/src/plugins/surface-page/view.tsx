import { createMemo, onCleanup, type JSX } from "solid-js"
import type { PageProps, SurfacePageDefinition } from "@claxedo/plugin-api"
import { uuid } from "@/lib/uuid"
import { createSurface, SurfaceView } from "@/surface"
import { TranscriptKitProviders } from "@/transcript"
import { openSurfacePage } from "./controller"

export function PluginSurfacePage(props: { readonly pluginName: string; readonly page: SurfacePageDefinition; readonly pageProps: PageProps }): JSX.Element {
  const surface = createSurface(uuid())
  const controller = openSurfacePage({ surface, page: props.page, props: props.pageProps })
  onCleanup(controller.close)
  const failure = createMemo(() => {
    const state = controller.state()
    if (state.kind === "failed") throw state.error
  })
  return (
    <>
      {failure()}
      <TranscriptKitProviders>
        <SurfaceView surface={surface} source={{ kind: "plugin", label: props.pluginName }} onAction={controller.action} />
      </TranscriptKitProviders>
    </>
  )
}
