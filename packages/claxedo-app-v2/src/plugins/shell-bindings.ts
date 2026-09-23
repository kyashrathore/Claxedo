import { entryId, type PluginApi } from "@claxedo/plugin-api"
import type { PaneKind, ShellRegistries } from "@/shell/types"
import { boundedView } from "./boundary"
import type { RegistrationSink } from "./registrations"

type ShellBindings = Pick<
  PluginApi,
  "sidebar" | "pages" | "panes" | "settings" | "overlays" | "commands" | "mentions" | "themes" | "icons"
>

export function createShellBindings(input: {
  readonly pluginId: string
  readonly pluginName: string
  readonly registries: ShellRegistries
  readonly sink: RegistrationSink
}): ShellBindings {
  const { registries, sink, pluginName } = input
  const tag = (id: string) => entryId(input.pluginId, id)
  return {
    sidebar: { item: (item) => sink.add(registries.sidebarItems, { ...item, id: tag(item.id), pageId: tag(item.pageId) }) },
    pages: {
      register: (page) => sink.add(registries.pages, { ...page, id: tag(page.id), view: boundedView(pluginName, page.view) }),
    },
    panes: {
      register: (kind) => {
        const tagged: PaneKind<never> = { ...kind, kind: tag(kind.kind), view: boundedView(pluginName, kind.view) } as PaneKind<never>
        return sink.add(registries.paneKinds, tagged)
      },
    },
    settings: {
      section: (section) =>
        sink.add(registries.settingsSections, { ...section, id: tag(section.id), view: boundedView(pluginName, section.view) }),
    },
    overlays: {
      register: (overlay) =>
        sink.add(registries.overlays, { ...overlay, id: tag(overlay.id), view: boundedView(pluginName, overlay.view) }),
    },
    commands: { register: (command) => sink.add(registries.commands, { ...command, id: tag(command.id) }) },
    mentions: { register: (source) => sink.add(registries.mentions, { ...source, id: tag(source.id) }) },
    themes: { register: (theme) => sink.add(registries.themes, { ...theme, id: tag(theme.id) }) },
    icons: { registerSkin: (skin) => sink.add(registries.iconSkins, { ...skin, id: tag(skin.id) }) },
  }
}
