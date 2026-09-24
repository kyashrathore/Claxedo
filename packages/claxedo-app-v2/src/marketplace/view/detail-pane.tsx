import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { useTranslator } from "@/i18n"
import type { PluginCandidate, PluginHarness, PluginToolGroup } from "@/server"
import { dictionary } from "../i18n"
import { isBuiltIn, pluginLabel, pluginStatus } from "../model"
import { createPaneWidth, PANE_MAX_FRACTION, PANE_MIN_WIDTH } from "../pane-width"
import { GHOST_ICON_BUTTON } from "./chrome"
import { PluginActions } from "./detail-actions"
import { PluginFacts } from "./detail-facts"
import { PluginSections } from "./detail-sections"
import { PluginIconTile } from "./plugin-icon"
import { SkillView } from "./skill-view"
import { PluginStatusLine } from "./status"

const RESIZE_STEP = 16

export type DetailHandlers = {
  readonly pending: boolean
  readonly onAdd: () => void
  readonly onActivate: (choice: boolean | null) => void
  readonly onUpdate: () => void
  readonly onToolGroup: (group: PluginToolGroup, enabled: boolean) => void
}

function DetailHeader(props: { readonly plugin: PluginCandidate; readonly onClose: () => void }): JSX.Element {
  const t = useTranslator(dictionary)
  const name = () => pluginLabel(props.plugin)
  const builtIn = () => isBuiltIn(props.plugin)
  return (
    <header class="flex items-start gap-3 border-b border-border-weak-base p-4">
      <PluginIconTile icon={props.plugin.icon} name={name()} size="pane" builtIn={builtIn()} />
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-16-medium text-text-strong">{name()}</h2>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-11-regular text-text-weaker">
          <Show when={props.plugin.manifest?.version}>{(version) => <span>v{version()}</span>}</Show>
          <span class="truncate">
            {builtIn() ? t("marketplace.builtIn") : (props.plugin.source?.label ?? t("marketplace.retainedArtifact"))}
          </span>
          <Show when={props.plugin.relativePath}>{(path) => <span class="truncate text-12-mono">{path()}</span>}</Show>
        </div>
        <Show when={pluginStatus(props.plugin)}>
          {(value) => (
            <div class="mt-1.5">
              <PluginStatusLine status={value()} wrap={builtIn()} />
            </div>
          )}
        </Show>
      </div>
      <button
        type="button"
        aria-label={t("marketplace.closeDetails")}
        class={`${GHOST_ICON_BUTTON} size-6`}
        onClick={() => props.onClose()}
      >
        ×
      </button>
    </header>
  )
}

function DetailNotes(props: { readonly plugin: PluginCandidate }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <>
      <Show when={props.plugin.manifest?.description}>
        {(description) => <p class="px-4 pt-3 text-13-regular text-text-base">{description()}</p>}
      </Show>
      <Show when={!isBuiltIn(props.plugin) && !props.plugin.sourceAvailable}>
        <p class="px-4 pt-2 text-12-regular text-text-weak">{t("marketplace.sourceUnavailable")}</p>
      </Show>
      <Show when={props.plugin.artifactError}>
        {(error) => <p class="px-4 pt-2 text-12-regular text-icon-critical-base">{error()}</p>}
      </Show>
    </>
  )
}

function createPaneSize() {
  const [width, setWidth] = createPaneWidth()
  const [surface, setSurface] = createSignal(window.innerWidth)
  let pane: HTMLElement | undefined
  const measure = () => setSurface(pane?.parentElement?.clientWidth || window.innerWidth)
  onMount(() => {
    measure()
    window.addEventListener("resize", measure)
    onCleanup(() => window.removeEventListener("resize", measure))
  })
  const maxWidth = () => Math.max(PANE_MIN_WIDTH, Math.round(surface() * PANE_MAX_FRACTION))
  const resize = (next: number) => setWidth(Math.min(maxWidth(), Math.max(PANE_MIN_WIDTH, Math.round(next))))
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? RESIZE_STEP : event.key === "ArrowRight" ? -RESIZE_STEP : 0
    const edge = event.key === "Home" ? maxWidth() : event.key === "End" ? PANE_MIN_WIDTH : undefined
    if (step === 0 && edge === undefined) return
    event.preventDefault()
    event.stopPropagation()
    resize(edge ?? width() + step)
  }
  return { width, maxWidth, resize, onKeyDown, ref: (element: HTMLElement) => (pane = element) }
}

export function PluginDetailPane(
  props: DetailHandlers & {
    readonly plugin: PluginCandidate
    readonly harnesses: readonly PluginHarness[]
    readonly onClose: () => void
  },
): JSX.Element {
  const t = useTranslator(dictionary)
  const [skill, setSkill] = createSignal<string>()
  const size = createPaneSize()
  const name = () => pluginLabel(props.plugin)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !skill()) return
    event.preventDefault()
    event.stopPropagation()
    setSkill(undefined)
  }
  return (
    <aside
      ref={size.ref}
      data-component="agent-plugin-detail"
      aria-label={t("marketplace.details", { name: name() })}
      style={{ width: `${size.width()}px` }}
      class="relative flex min-h-0 max-w-full shrink-0 flex-col border-l border-border-weak-base bg-surface-base"
      onKeyDown={onKeyDown}
    >
      <ResizeHandle
        direction="horizontal"
        edge="start"
        size={size.width()}
        min={PANE_MIN_WIDTH}
        max={size.maxWidth()}
        onResize={size.resize}
        role="separator"
        tabIndex={0}
        aria-label={t("marketplace.resizeDetails")}
        aria-orientation="vertical"
        aria-valuenow={size.width()}
        aria-valuemin={PANE_MIN_WIDTH}
        aria-valuemax={size.maxWidth()}
        onKeyDown={size.onKeyDown}
      />
      <Show
        when={skill()}
        fallback={
          <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <DetailHeader plugin={props.plugin} onClose={props.onClose} />
            <PluginFacts plugin={props.plugin} />
            <DetailNotes plugin={props.plugin} />
            <PluginActions {...props} />
            <PluginSections {...props} onSkill={setSkill} />
          </div>
        }
      >
        {(open) => (
          <SkillView
            pluginInstanceId={props.plugin.pluginInstanceId}
            pluginName={name()}
            skill={open()}
            onBack={() => setSkill(undefined)}
          />
        )}
      </Show>
    </aside>
  )
}
