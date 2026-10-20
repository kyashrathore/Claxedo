import type { Component } from "solid-js"
import type { PageDefinition, PluginApi, SettingsSectionDefinition } from "@claxedo/plugin-api"
import { fillPattern, settingsPath, type PageEntry, type PageProps, type SettingsSection } from "@/shell"
import { boundedView } from "../boundary"
import { PluginSurfacePage, PluginSurfaceSettings } from "../surface-page/view"
import { entryId, pageEntryFor, PluginEntryError, type BindingScope } from "./services"

export const PLUGIN_ICON = "grid-plus"

type Regions = Pick<PluginApi, "sidebar" | "pages" | "settings" | "overlays">

function pageView(scope: BindingScope, page: PageDefinition): Component<PageProps> {
  if (!("surface" in page)) return (props) => page.render({ path: page.path, params: props.params })
  return (props) => PluginSurfacePage({ pluginName: scope.manifest.name, page, params: () => props.params })
}

function pageEntry(scope: BindingScope, page: PageDefinition): PageEntry {
  const view = pageView(scope, page)
  const surface = "surface" in page ? page : undefined
  return {
    id: entryId(scope.manifest.id, page.id),
    path: page.path,
    title: () => page.title,
    icon: surface?.icon ?? PLUGIN_ICON,
    sidebar: "main",
    ...(surface?.tab ? { tab: true } : {}),
    view: boundedView(scope.manifest.name, view),
  }
}

function registerPage(scope: BindingScope, page: PageDefinition) {
  const pages = scope.services.registries.pages
  const entry = pageEntry(scope, page)
  const ownPrefix = entryId(scope.manifest.id, "")
  if (pages.list().some((existing) => existing.path === page.path && !existing.id.startsWith(ownPrefix))) {
    throw new PluginEntryError(scope.manifest.id, `the path ${page.path} already belongs to another page`)
  }
  return scope.sink.add(pages, entry)
}

function openPage(scope: BindingScope, pageId: string, params?: Readonly<Record<string, string>>) {
  const entry = pageEntryFor(scope, pageId)
  if (!entry) throw new PluginEntryError(scope.manifest.id, `no page ${pageId} is registered`)
  scope.services.routing.navigate(fillPattern(entry.path, params))
}

function settingsEntry(scope: BindingScope, section: SettingsSectionDefinition): SettingsSection {
  const pluginName = scope.manifest.name
  const view: Component = "surface" in section ? () => PluginSurfaceSettings({ pluginName, section }) : () => section.render()
  return {
    id: entryId(scope.manifest.id, section.id),
    title: () => section.title,
    group: ("surface" in section ? section.group : undefined) ?? "app",
    order: section.order,
    view: boundedView(pluginName, view),
  }
}

function openSettings(scope: BindingScope, sectionId: string) {
  const id = entryId(scope.manifest.id, sectionId)
  if (!scope.services.registries.settingsSections.list().some((section) => section.id === id)) {
    throw new PluginEntryError(scope.manifest.id, `no settings section ${sectionId} is registered`)
  }
  scope.services.routing.navigate(settingsPath(id))
}

export function regionBindings(scope: BindingScope): Regions {
  const { registries, overlays } = scope.services
  const pluginId = scope.manifest.id
  return {
    sidebar: {
      item: (item) =>
        scope.sink.add(registries.sidebarItems, {
          id: entryId(pluginId, item.id),
          title: () => item.label,
          icon: item.icon ?? PLUGIN_ICON,
          pageId: entryId(pluginId, item.pageId),
          order: item.order,
        }),
    },
    pages: { register: (page) => registerPage(scope, page), open: (pageId, params) => openPage(scope, pageId, params) },
    settings: {
      section: (section) => scope.sink.add(registries.settingsSections, settingsEntry(scope, section)),
      open: (sectionId) => openSettings(scope, sectionId),
    },
    overlays: {
      register: (overlay) => {
        const id = entryId(pluginId, overlay.id)
        const view = overlays.track(id, (props) => overlay.render(props))
        return scope.sink.add(registries.overlays, { id, keybinding: overlay.keybinding, view: boundedView(scope.manifest.name, view) })
      },
      open: (overlayId) => overlays.open(entryId(pluginId, overlayId)),
      close: (overlayId) => overlays.close(entryId(pluginId, overlayId)),
    },
  }
}
