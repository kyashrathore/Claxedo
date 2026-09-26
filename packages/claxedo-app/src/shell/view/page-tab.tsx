import { createMemo, Show, type JSX } from "solid-js"
import { readString } from "@claxedo/helpers/readers"
import { useShellRegistries } from "../registries"
import { parseRoute } from "../routes"
import type { PageEntry, PaneKind, PaneProps } from "../types"
import { PageView } from "./page-view"

export type PageTabState = { readonly path: string }

function tabPageAt(path: string, pages: readonly PageEntry[]) {
  const route = parseRoute(path, pages, [])
  return route.kind === "page" && route.page.tab ? route : undefined
}

function PageTab(props: PaneProps<PageTabState>): JSX.Element {
  const registries = useShellRegistries()
  const route = createMemo(() => tabPageAt(props.state.path, registries.pages.list()))
  return <Show when={route()}>{(page) => <PageView page={page().page} params={page().params} />}</Show>
}

export const pageTabPaneKind: PaneKind<PageTabState> = {
  kind: "pageTab",
  singleton: true,
  title: (state) => tabPageAt(state.path, useShellRegistries().pages.list())?.page.title() ?? "",
  view: PageTab,
  encode: (state) => ({ path: state.path }),
  decode: (value) => {
    const path = readString(value, "path")
    return path ? { path } : undefined
  },
  fromRoute: (route) => (route.kind === "pageTab" ? { path: route.path } : undefined),
  toRoute: (state) => ({ kind: "pageTab", path: state.path }),
}
