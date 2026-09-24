import { Match, Show, Switch, type JSX } from "solid-js"
import { isMarkdownPath, useFiles } from "@/files"
import { useTranslator } from "@/i18n"
import {
  ClaxedoIcon as Icon,
  setBrowserToolbarSlot,
  setFileHeaderActionsSlot,
  setReviewControlsSlot,
  setReviewToolbarSlot,
} from "@/ui"
import { filePathFromTab } from "../focus"
import { dictionary } from "../i18n"
import { usePanel } from "../store"
import { PanelTabStrip } from "./tab-strip"
import { PanelToggleButton } from "./toggle"
import { WorkspaceToolButtons } from "./tool-buttons"

function PanelChrome(): JSX.Element {
  const t = useTranslator(dictionary)
  const panel = usePanel()
  const label = () => (panel.fullWidth() ? t("panel.restore") : t("panel.maximize"))
  return (
    <div class="flex shrink-0 items-center gap-0.5 pl-1">
      <button
        type="button"
        data-icon-interaction="binary"
        class="flex size-6 items-center justify-center rounded-sm text-icon-weak-base transition-colors duration-100 hover:bg-surface-base-hover hover:text-icon-base"
        aria-label={label()}
        title={label()}
        aria-pressed={panel.fullWidth()}
        onClick={() => panel.toggleFullWidth()}
      >
        <Icon name={panel.fullWidth() ? "collapse" : "expand"} size="small" />
      </button>
      <PanelToggleButton />
    </div>
  )
}

function Tools(): JSX.Element {
  const panel = usePanel()
  return (
    <WorkspaceToolButtons
      available={panel.placementId() !== undefined}
      filesActive={panel.navigator() === "files"}
      changesActive={panel.navigator() === "changes"}
      onToggle={panel.toggleNavigator}
    />
  )
}

function FileContext(props: { readonly path: string }): JSX.Element {
  const t = useTranslator(dictionary)
  const files = useFiles()
  const label = () => (files.markdownSource(props.path) ? t("panel.markdown.preview") : t("panel.markdown.source"))
  return (
    <div data-l2-context="file" class="flex min-w-0 flex-1 items-center gap-2 px-2">
      <Icon name="document-text" size="small" class="shrink-0 text-icon-weak-base" />
      <span class="truncate font-mono text-xs text-text-weak" title={props.path}>
        {props.path}
      </span>
      <Show when={isMarkdownPath(props.path)}>
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded-sm text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base"
          aria-label={label()}
          title={label()}
          onClick={() => files.toggleMarkdownSource(props.path)}
        >
          <Icon name={files.markdownSource(props.path) ? "eye" : "code"} size="small" />
        </button>
      </Show>
      <span
        ref={(element) => {
          setFileHeaderActionsSlot(element)
          return () => setFileHeaderActionsSlot(null)
        }}
        class="flex shrink-0 items-center gap-0.5"
      />
      <span class="flex-1" />
      <Tools />
    </div>
  )
}

function ToolbarRow(): JSX.Element {
  const panel = usePanel()
  const tab = () => panel.activeTab()
  const filePath = () => {
    const active = tab()
    return active.kind === "file" ? filePathFromTab(active.tabId) : undefined
  }
  const label = () => {
    const active = tab()
    if (active.kind === "subagent") return active.label
    if (active.kind === "plan") return active.title
    return undefined
  }
  const description = () => {
    const active = tab()
    return active.kind === "subagent" ? active.description : undefined
  }
  return (
    <div
      data-testid="workbench-l2-header"
      class="flex h-9 w-full max-w-full min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-border-weaker-base bg-background-base"
    >
      <Switch>
        <Match when={tab().kind === "review"}>
          <div data-l2-context="review" class="flex min-w-0 flex-1 items-center gap-2 pl-2 pr-2">
            <div
              ref={(element) => {
                setReviewToolbarSlot(element)
                return () => setReviewToolbarSlot(null)
              }}
              data-testid="l2-review-toolbar-slot"
              class="flex min-w-0 flex-1 items-center gap-2"
            />
            <div
              ref={(element) => {
                setReviewControlsSlot(element)
                return () => setReviewControlsSlot(null)
              }}
              data-testid="l2-review-controls-slot"
              class="flex shrink-0 items-center gap-0.5"
            />
            <Tools />
          </div>
        </Match>
        <Match when={tab().kind === "browser"}>
          <div
            data-l2-context="browser"
            class="grid h-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 pr-2"
          >
            <div
              ref={(element) => {
                setBrowserToolbarSlot(element)
                return () => setBrowserToolbarSlot(null)
              }}
              data-testid="l2-browser-toolbar-slot"
              class="flex h-full min-w-0 w-full items-center overflow-hidden [&>*]:min-w-0 [&>*]:w-full [&>*]:flex-1"
            />
            <Tools />
          </div>
        </Match>
        <Match when={filePath()}>{(path) => <FileContext path={path()} />}</Match>
        <Match when={true}>
          <div data-l2-context={tab().kind} class="flex min-w-0 flex-1 items-center gap-2 px-2">
            <span
              class="text-sm"
              classList={{
                "shrink-0 text-text-base": tab().kind === "subagent",
                "truncate text-text-weak": tab().kind !== "subagent",
              }}
            >
              {label()}
            </span>
            <Show when={description()}>
              {(text) => (
                <span class="truncate text-sm text-text-weak" title={text()}>
                  {text()}
                </span>
              )}
            </Show>
            <span class="flex-1" />
            <Tools />
          </div>
        </Match>
      </Switch>
    </div>
  )
}

export function PanelHeader(): JSX.Element {
  const panel = usePanel()
  return (
    <div class="shrink-0 bg-background-base">
      <div
        data-testid="workspace-panel-l1-header"
        class="relative flex h-9 shrink-0 items-center overflow-hidden border-b border-border-weaker-base bg-background-base"
      >
        <div class="flex h-full min-w-0 flex-1 items-center overflow-hidden">
          <PanelTabStrip />
        </div>
        <div class="flex h-full shrink-0 items-center pr-1">
          <Show when={panel.open()}>
            <PanelChrome />
          </Show>
        </div>
      </div>
      <ToolbarRow />
    </div>
  )
}
