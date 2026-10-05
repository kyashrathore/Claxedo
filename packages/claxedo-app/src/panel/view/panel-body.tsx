import { createMemo, createSignal, Match, Show, Switch, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { DelayedLoading, MarkedProvider } from "@/ui"
import { BrowserTabView } from "@/browser"
import { SelectionComment } from "@/composer"
import { FileTab, FilesNavigator } from "@/files"
import { useTranslator } from "@/i18n"
import { ReviewTab, SourceControlView, useLineComments } from "@/review"
import { useServer, type PlacementId } from "@/server"
import { usePreferences } from "@/settings"
import { useShellRegistries, type PanelView } from "@/shell"
import { Markdown } from "@/transcript"
import { createSidePanelExposed } from "@/lib/side-panel-motion"
import { filePathFromTab } from "../focus"
import { panelDictionary } from "../i18n"
import { usePanel, type Panel } from "../store"
import { NavigatorResizeHandle } from "./resize-handle"

const NAVIGATOR_TRANSITION = "transform 120ms cubic-bezier(0.2, 0, 0, 1), width 120ms cubic-bezier(0.2, 0, 0, 1)"

function activeFilePath(panel: Panel): string | undefined {
  const tab = panel.activeTab()
  return tab.kind === "file" ? filePathFromTab(tab.tabId) : undefined
}

function NavigatorViews(props: { readonly placementId: PlacementId }): JSX.Element {
  const panel = usePanel()
  const view = createMemo<ReturnType<Panel["navigator"]>>((last) => panel.navigator() ?? last, null)
  return (
    <div class="absolute inset-0">
      <Switch>
        <Match when={view() === "files"}>
          <FilesNavigator
            placementId={props.placementId}
            active={panel.open() && panel.navigator() === "files"}
            activePath={activeFilePath(panel)?.startsWith("/") ? undefined : activeFilePath(panel)}
            onOpenFile={(path) => panel.show({ kind: "file", path })}
          />
        </Match>
        <Match when={view() === "changes"}>
          <SourceControlView
            placementId={props.placementId}
            active={panel.open() && panel.navigator() === "changes"}
            activePath={panel.reviewFocus()?.path}
            onFileClick={(path) => panel.show({ kind: "review", path })}
          />
        </Match>
      </Switch>
    </div>
  )
}

function NavigatorColumn(props: { readonly placementId: PlacementId }): JSX.Element {
  const panel = usePanel()
  const preferences = usePreferences()
  const side = () => preferences.appearance.navigatorSide
  const left = () => side() === "left"
  const selected = () => panel.navigator() !== null && !panel.phone()
  const visited = createMemo<boolean>((was) => was || (panel.open() && selected()), false)
  const shown = createSidePanelExposed(() => panel.open() && selected())
  const [dragging, setDragging] = createSignal(false)
  const width = () => `${panel.navigatorWidth()}px`
  return (
    <Show when={visited()}>
      <div
        data-testid="workspace-navigator-overlay"
        data-navigator="files"
        data-navigator-kind={panel.navigator() ?? "files"}
        data-open={selected() ? "true" : "false"}
        aria-hidden={selected() ? undefined : "true"}
        data-navigator-side={side()}
        class="claxedo-workspace-navigator-overlay box-content h-full shrink-0 overflow-hidden border-border-weak-base bg-background-base motion-reduce:transition-none"
        classList={{
          "order-first border-r": left(),
          "order-last border-l": !left(),
          "pointer-events-none": !selected(),
          "border-transparent": !selected(),
        }}
        style={{
          width: selected() ? width() : "0px",
          transition: dragging() ? "none" : NAVIGATOR_TRANSITION,
          "content-visibility": selected() ? "visible" : "hidden",
        }}
      >
        <div class="relative h-full" style={{ width: width() }}>
          <Show when={shown()}>
            <NavigatorViews placementId={props.placementId} />
          </Show>
        </div>
      </div>
      <Show when={selected()}>
        <div class="relative w-0 shrink-0" classList={{ "-order-1": left(), "order-1": !left() }}>
          <NavigatorResizeHandle side={side()} onDragging={setDragging} />
        </div>
      </Show>
    </Show>
  )
}

function RegisteredView(props: {
  readonly kind: PanelView["kind"]
  readonly placementId: PlacementId
  readonly sessionId: string
  readonly parentSessionId?: string
}): JSX.Element {
  const registries = useShellRegistries()
  const view = () => registries.panelViews.list().find((entry) => entry.kind === props.kind)?.view
  return (
    <Show when={view()}>
      {(component) => (
        <div class="absolute inset-0 h-full min-h-0 overflow-hidden">
          <Dynamic
            component={component()}
            placementId={props.placementId}
            sessionId={props.sessionId}
            parentSessionId={props.parentSessionId}
          />
        </div>
      )}
    </Show>
  )
}

function PlanTab(props: { readonly markdown: string; readonly composerKey: () => string | undefined }): JSX.Element {
  const [content, setContent] = createSignal<HTMLDivElement>()
  return (
    <div class="absolute inset-0 h-full min-h-0 overflow-hidden">
      <div data-testid="workspace-plan-tab" class="h-full min-h-0 overflow-y-auto">
        <div ref={setContent} class="px-6 py-4">
          <Markdown text={props.markdown} />
        </div>
      </div>
      <SelectionComment root={content} composerKey={props.composerKey} source={{ kind: "plan" }} />
    </div>
  )
}

function ActiveTab(props: { readonly placementId: PlacementId }): JSX.Element {
  const panel = usePanel()
  const tab = () => panel.activeTab()
  const context = () => {
    const current = tab()
    return current.kind === "context" ? current : undefined
  }
  const subagent = () => {
    const current = tab()
    return current.kind === "subagent" ? current : undefined
  }
  const plan = () => {
    const current = tab()
    return current.kind === "plan" ? current : undefined
  }
  const fileComments = useLineComments("file")
  const reveal = (path: string) => {
    const current = panel.fileReveal()
    return current?.path === path ? current : undefined
  }
  return (
    <Switch>
      <Match when={tab().kind === "review"}>
        <div data-testid="review-pane-root" class="absolute inset-0 flex h-full flex-col overflow-hidden">
          <ReviewTab
            placementId={props.placementId}
            focus={panel.reviewFocus()}
            onOpenFile={(path) => panel.show({ kind: "file", path })}
          />
        </div>
      </Match>
      <Match when={activeFilePath(panel)} keyed>
        {(path) => (
          <div class="absolute inset-0 h-full min-h-0 overflow-hidden">
            <FileTab
              placementId={props.placementId}
              path={path}
              headerActive
              focusLine={reveal(path)?.line}
              focusNonce={reveal(path)?.version}
              comments={fileComments}
            />
          </div>
        )}
      </Match>
      <Match when={context()}>
        {(current) => <RegisteredView kind="context" placementId={props.placementId} sessionId={current().sessionId} />}
      </Match>
      <Match when={subagent()}>
        {(current) => (
          <RegisteredView
            kind="subagent"
            placementId={props.placementId}
            sessionId={current().sessionId}
            parentSessionId={current().parentSessionId}
          />
        )}
      </Match>
      <Match when={plan()}>
        {(current) => <PlanTab markdown={current().markdown} composerKey={fileComments.composerKey} />}
      </Match>
    </Switch>
  )
}

function BrowserPanel(): JSX.Element {
  const panel = usePanel()
  const browser = createMemo(() => panel.tabs().find((tab) => tab.kind === "browser"))
  const active = () => panel.open() && panel.activeTab().kind === "browser"
  return (
    <BrowserTabView
      open={!!browser()}
      url={browser()?.url}
      navigationVersion={browser()?.navigationVersion}
      active={active()}
    />
  )
}

function WorkspacePending(props: { readonly placementId: PlacementId }): JSX.Element {
  const t = useTranslator(panelDictionary)
  const server = useServer()
  const offline = () => server.placements.byId(props.placementId)?.reachable === false
  const connecting = () => server.connection().kind === "connecting"
  return (
    <Show when={offline() || connecting()}>
      <div
        data-testid="workspace-review-pending"
        class="absolute inset-0 z-10 flex min-w-0 items-center justify-center bg-background-base px-6 text-center text-compact text-text-weak"
      >
        <Show when={!offline()} fallback={<span>{t("panel.unavailable")}</span>}>
          <DelayedLoading>
            <span>{t("panel.connecting")}</span>
          </DelayedLoading>
        </Show>
      </div>
    </Show>
  )
}

export function PanelBody(props: { readonly tabsShown: boolean }): JSX.Element {
  const t = useTranslator(panelDictionary)
  const panel = usePanel()
  return (
    <MarkedProvider>
      <div class="flex h-full min-h-0 flex-col">
        <div class="min-h-0 flex-1 overflow-hidden">
          <div
            class="relative flex size-full min-w-0 overflow-hidden [container-type:inline-size]"
            data-workspace-panel-session-id={panel.sessionId()}
          >
            <Show keyed when={panel.allowed() && panel.placementId()}>
              {(placementId) => <NavigatorColumn placementId={placementId} />}
            </Show>
            <Show keyed when={props.tabsShown && panel.placementId()}>
              {(placementId) => <WorkspacePending placementId={placementId} />}
            </Show>
            <div class="h-full min-w-0 flex-1">
              <div class="relative flex size-full min-h-0 overflow-hidden bg-background-base h-full">
                <div id="review-panel" class="relative flex-1 min-w-0 flex flex-col h-full">
                  <div class="flex min-h-0 flex-1 flex-col bg-background-stronger">
                    <div class="relative min-h-0 flex-1 overflow-hidden contain-strict">
                      <BrowserPanel />
                      <Show keyed when={props.tabsShown && panel.placementId()}>
                        {(placementId) => <ActiveTab placementId={placementId} />}
                      </Show>
                      <Show when={props.tabsShown && !panel.placementId()}>
                        <div class="flex h-full items-center justify-center px-6 text-center text-compact text-text-weak">
                          {t("panel.noPlacement")}
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </MarkedProvider>
  )
}
