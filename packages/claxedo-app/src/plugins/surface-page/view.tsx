import { untrack, type Accessor, type JSX } from "solid-js"
import type { PageProps, SurfacePageDefinition, SurfaceSettingsSection } from "@claxedo/plugin-api"
import { PluginSurface } from "./drawn-surface"
import { followPageParams, pageParams, type PageParams } from "./page-params"

export function PluginSurfacePage(props: { readonly pluginName: string; readonly page: SurfacePageDefinition; readonly params: Accessor<PageParams> }): JSX.Element {
  const params = pageParams(() => props.params())
  const pageProps = (current: PageParams): PageProps => ({ path: props.page.path, params: current })
  return (
    <PluginSurface
      pluginName={props.pluginName}
      label={`page ${props.page.id}`}
      open={(channel) => props.page.surface(channel, pageProps(untrack(params)))}
      opened={(controller) => followPageParams(params, (current) => controller.navigated(pageProps(current)))}
    />
  )
}

export function PluginSurfaceSettings(props: { readonly pluginName: string; readonly section: SurfaceSettingsSection }): JSX.Element {
  return <PluginSurface pluginName={props.pluginName} label={`settings section ${props.section.id}`} open={(channel) => props.section.surface(channel)} />
}
