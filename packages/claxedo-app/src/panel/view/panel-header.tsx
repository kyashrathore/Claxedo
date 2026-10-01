import { children, Match, Show, Switch, type JSX } from "solid-js"
import { isMarkdownPath, useFiles } from "@/files"
import { useTranslator } from "@/i18n"
import { usePreferences } from "@/settings"
import {
  ClaxedoIcon as Icon,
  SidePanelHeader,
  setBrowserToolbarSlot,
  setFileHeaderActionsSlot,
  setReviewControlsSlot,
  setReviewToolbarSlot,
} from "@/ui"
import { filePathFromTab } from "../focus"
import { panelDictionary } from "../i18n"
import { usePanel } from "../store"
import { PanelTabStrip } from "./tab-strip"
import { WorkspaceToolButtons } from "./tool-buttons"

function Tools(): JSX.Element {
  const panel = usePanel()
  return (
    <WorkspaceToolButtons
      available={panel.placementId() !== undefined && !panel.phone()}
      filesActive={panel.navigator() === "files"}
      changesActive={panel.navigator() === "changes"}
      showChanges
      onToggle={panel.toggleNavigator}
    />
  )
}

function ToolbarContext(props: {
  readonly leads: boolean
  readonly class: string
  readonly controls?: JSX.Element
  readonly children: JSX.Element
}): JSX.Element {
  const context = children(() => props.children)
  const controls = children(() => props.controls)
  const tools = <Tools />
  const edge = (
    <div class="flex shrink-0 items-center gap-2">{props.leads ? [tools, controls()] : [controls(), tools]}</div>
  )
  return (
    <div class={`flex h-full min-w-0 flex-1 items-center justify-between gap-2 ${props.class}`}>
      {props.leads ? [edge, context()] : [context(), edge]}
    </div>
  )
}

function FileContext(props: { readonly path: string }): JSX.Element {
  const t = useTranslator(panelDictionary)
  const files = useFiles()
  const label = () => (files.markdownSource(props.path) ? t("panel.markdown.preview") : t("panel.markdown.source"))
  return (
    <div class="flex min-w-0 flex-1 items-center gap-2">
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
    </div>
  )
}

function ToolbarRow(): JSX.Element {
  const panel = usePanel()
  const preferences = usePreferences()
  const leads = () => preferences.appearance.navigatorSide === "left" && !panel.phone()
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
          <ToolbarContext
            leads={leads()}
            class="px-2"
            controls={
              <div
                ref={(element) => {
                  setReviewControlsSlot(element)
                  return () => setReviewControlsSlot(null)
                }}
                data-testid="l2-review-controls-slot"
                class="flex shrink-0 items-center gap-0.5"
              />
            }
          >
            <div
              ref={(element) => {
                setReviewToolbarSlot(element)
                return () => setReviewToolbarSlot(null)
              }}
              data-testid="l2-review-toolbar-slot"
              class="flex min-w-0 items-center gap-2"
            />
          </ToolbarContext>
        </Match>
        <Match when={tab().kind === "browser"}>
          <ToolbarContext leads={leads()} class={leads() ? "pl-2" : "pr-2"}>
            <div
              ref={(element) => {
                setBrowserToolbarSlot(element)
                return () => setBrowserToolbarSlot(null)
              }}
              data-testid="l2-browser-toolbar-slot"
              class="flex h-full min-w-0 w-full flex-1 items-center overflow-hidden [&>*]:min-w-0 [&>*]:w-full [&>*]:flex-1"
            />
          </ToolbarContext>
        </Match>
        <Match when={filePath()}>
          {(path) => (
            <ToolbarContext leads={leads()} class="px-2">
              <FileContext path={path()} />
            </ToolbarContext>
          )}
        </Match>
        <Match when={true}>
          <ToolbarContext leads={leads()} class="px-2">
            <div class="flex min-w-0 flex-1 items-center gap-2">
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
            </div>
          </ToolbarContext>
        </Match>
      </Switch>
    </div>
  )
}

export function PanelHeader(): JSX.Element {
  const panel = usePanel()
  const t = useTranslator(panelDictionary)
  return (
    <SidePanelHeader
      testId="workspace-panel-l1-header"
      tabs={<PanelTabStrip />}
      controls={{
        phone: panel.phone(),
        fullWidth: panel.fullWidth(),
        maximizeLabel: t(panel.fullWidth() ? "panel.restore" : "panel.maximize"),
        closeLabel: t("panel.close"),
        onMaximize: panel.toggleFullWidth,
        onClose: panel.toggle,
        closeTestId: "workspace-panel-toggle",
      }}
      toolbar={<ToolbarRow />}
    />
  )
}
