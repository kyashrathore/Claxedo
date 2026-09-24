import type { Component } from "solid-js"
import type { PageDefinition, PluginApi } from "@claxedo/plugin-api"
import { fillPattern, type PageEntry, type PageProps } from "@/shell"
import { boundedView } from "../boundary"
import { entryId, PluginEntryError, type BindingScope } from "./services"

export const PLUGIN_ICON = "grid-plus"

type Regions = Pick<PluginApi, "sidebar" | "pages" | "settings" | "overlays">

function pageEntry(scope: BindingScope, page: PageDefinition): PageEntry {
  const view: Component<PageProps> = (props) => page.render({ path: page.path, params: props.params })
  return {
    id: entryId(scope.manifest.id, page.id),
    path: page.path,
    title: () => page.title,
    icon: PLUGIN_ICON,
    sidebar: "main",
    view: boundedView(scope.manifest.name, view),
  }
}

function registerPage(scope: BindingScope, page: PageDefinition) {
  const pages = scope.services.registries.pages
  const entry = pageEntry(scope, page)
  if (pages.list().some((existing) => existing.path === page.path)) {
    throw new PluginEntryError(scope.manifest.id, `the path ${page.path} already belongs to another page`)
  }
  return scope.sink.add(pages, entry)
}

function openPage(scope: BindingScope, pageId: string, params?: Readonly<Record<string, string>>) {
  const pages = scope.services.registries.pages.list()
  const entry = pages.find((page) => page.id === entryId(scope.manifest.id, pageId)) ?? pages.find((page) => page.id === pageId)
  if (!entry) throw new PluginEntryError(scope.manifest.id, `no page ${pageId} is registered`)
  scope.services.routing.navigate(fillPattern(entry.path, params))
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
      section: (section) =>
        scope.sink.add(registries.settingsSections, {
          id: entryId(pluginId, section.id),
          title: () => section.title,
          group: "app",
          order: section.order,
          view: boundedView(scope.manifest.name, () => section.render()),
        }),
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
