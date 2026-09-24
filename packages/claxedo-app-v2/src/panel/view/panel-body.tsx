import { createEffect, createSignal, Match, Show, Switch, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { BrowserTabView } from "@/browser"
import { FileTab, FilesNavigator } from "@/files"
import { useTranslator } from "@/i18n"
import { ReviewTab, SourceControlView } from "@/review"
import type { PlacementId } from "@/server"
import { useShellRegistries, type PanelView } from "@/shell"
import { Markdown } from "@/transcript"
import { filePathFromTab } from "../focus"
import { dictionary } from "../i18n"
import { usePanel, type Panel } from "../store"

const NAVIGATOR_TRANSITION = "transform 120ms cubic-bezier(0.2, 0, 0, 1), width 120ms cubic-bezier(0.2, 0, 0, 1)"

function activeFilePath(panel: Panel): string | undefined {
  const tab = panel.activeTab()
  return tab.kind === "file" ? filePathFromTab(tab.tabId) : undefined
}

function NavigatorViews(props: { readonly placementId: PlacementId }): JSX.Element {
  const panel = usePanel()
  const view = () => panel.navigator()
  const [filesVisited, setFilesVisited] = createSignal(view() === "files")
  const [changesVisited, setChangesVisited] = createSignal(view() === "changes")
  createEffect(() => {
    if (view() === "files") setFilesVisited(true)
    if (view() === "changes") setChangesVisited(true)
  })
  return (
    <>
      <Show when={filesVisited()}>
        <div class="absolute inset-0" classList={{ hidden: view() !== "files" }}>
          <FilesNavigator
            placementId={props.placementId}
            active={view() === "files"}
            activePath={activeFilePath(panel)}
            onOpenFile={(path) => panel.show({ kind: "file", path })}
          />
        </div>
      </Show>
      <Show when={changesVisited()}>
        <div class="absolute inset-0" classList={{ hidden: view() !== "changes" }}>
          <SourceControlView
            placementId={props.placementId}
            active={view() === "changes"}
            activePath={panel.reviewFocus()?.path}
            onFileClick={(path) => panel.show({ kind: "review", path })}
          />
        </div>
      </Show>
    </>
  )
}

function NavigatorColumn(props: { readonly placementId: PlacementId }): JSX.Element {
  const panel = usePanel()
  const selected = () => panel.navigator() !== null
  const [visited, setVisited] = createSignal(selected())
  createEffect(() => {
    if (selected()) setVisited(true)
  })
  return (
    <Show when={visited()}>
      <div
        data-testid="workspace-navigator-overlay"
        data-navigator="files"
        data-navigator-kind={panel.navigator() ?? "files"}
        data-open={selected() ? "true" : "false"}
        aria-hidden={selected() ? undefined : "true"}
        class="claxedo-workspace-navigator-overlay order-last h-full shrink-0 overflow-hidden border-l border-border-weak-base bg-background-base motion-reduce:transition-none"
        classList={{ "pointer-events-none": !selected(), "border-transparent": !selected() }}
        style={{
          width: selected() ? "min(280px, 45%)" : "0px",
          transition: NAVIGATOR_TRANSITION,
          "content-visibility": selected() ? "visible" : "hidden",
        }}
      >
        <div class="relative h-full w-[min(280px,45cqw)] min-w-[220px]">
          <NavigatorViews placementId={props.placementId} />
        </div>
      </div>
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
  const browser = () => {
    const current = tab()
    return current.kind === "browser" ? current : undefined
  }
  const plan = () => {
    const current = tab()
    return current.kind === "plan" ? current : undefined
  }
  const reveal = (path: string) => {
    const current = panel.fileReveal()
    return current?.path === path ? current : undefined
  }
  return (
    <Switch>
      <Match when={tab().kind === "review"}>
        <div data-testid="workspace-review-body" class="absolute inset-0 flex h-full flex-col overflow-hidden">
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
            />
          </div>
        )}
      </Match>
      <Match when={browser()}>
        {(current) => (
          <div class="absolute inset-0 h-full min-h-0 overflow-hidden">
            <BrowserTabView url={current().url} navigationVersion={current().navigationVersion} />
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
        {(current) => (
          <div class="absolute inset-0 h-full min-h-0 overflow-hidden">
            <div data-testid="workspace-plan-tab" class="h-full min-h-0 overflow-y-auto">
              <div class="px-6 py-4">
                <Markdown text={current().markdown} />
              </div>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  )
}

export function PanelBody(): JSX.Element {
  const t = useTranslator(dictionary)
  const panel = usePanel()
  return (
    <Show
      keyed
      when={panel.placementId()}
      fallback={
        <div class="flex h-full items-center justify-center px-6 text-center text-compact text-text-weak">
          {t("panel.noPlacement")}
        </div>
      }
    >
      {(placementId) => (
        <MarkedProvider>
          <div class="flex h-full min-h-0 flex-col">
            <div class="min-h-0 flex-1 overflow-hidden">
              <div
                class="relative flex size-full min-w-0 overflow-hidden"
                data-workspace-panel-session-id={panel.sessionId()}
              >
                <NavigatorColumn placementId={placementId} />
                <div class="h-full min-w-0 flex-1">
                  <div class="relative flex size-full min-h-0 overflow-hidden bg-background-base h-full">
                    <div id="review-panel" class="relative flex-1 min-w-0 flex flex-col h-full">
                      <div class="flex min-h-0 flex-1 flex-col bg-background-stronger">
                        <div class="relative min-h-0 flex-1 overflow-hidden contain-strict">
                          <ActiveTab placementId={placementId} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </MarkedProvider>
      )}
    </Show>
  )
}
