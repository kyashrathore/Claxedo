import { createMemo, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip"
import { Accordion } from "@opencode-ai/ui/accordion"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { useLanguage } from "@/platform/i18n/provider"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { normalize } from "@/ui/session-kit"
import type { SummaryDiff } from "./message-timeline.data"

export function TimelineDiffSummaryRow(props: { diffs: SummaryDiff[]; onUndo?: () => Promise<unknown> | void }) {
  const language = useLanguage()
  const maxFiles = 3
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
    undoing: false,
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const overflow = createMemo(() => Math.max(0, props.diffs.length - maxFiles))
  const visible = createMemo(() => (showAll() ? props.diffs : props.diffs.slice(0, maxFiles)))

  // Undo the whole turn's edits via the git-snapshot revert (T9, D§3.9).
  const undo = () => {
    if (!props.onUndo || state.undoing) return
    setState("undoing", true)
    void Promise.resolve()
      .then(() => props.onUndo!())
      .finally(() => setState("undoing", false))
  }

  return (
    <div
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={showAll() || undefined}
    >
      <div data-slot="session-turn-diffs-header">
        <span data-slot="session-turn-diffs-label">
          {props.diffs.length} {language.t("ui.sessionTurn.diffs.changed")}{" "}
          {language.t(props.diffs.length === 1 ? "ui.common.file.one" : "ui.common.file.other")}
        </span>
        <DiffChanges changes={props.diffs} />
        <Show when={props.onUndo}>
          <button
            type="button"
            data-slot="session-turn-diffs-undo"
            class="text-12-medium text-text-weak hover:text-text-strong active:scale-[0.96] transition-transform disabled:opacity-50 cursor-pointer bg-transparent border-none px-1"
            disabled={state.undoing}
            onClick={(event) => {
              event.stopPropagation()
              undo()
            }}
          >
            {language.t("ui.message.revertMessage")}
          </button>
        </Show>
        <Show when={overflow() > 0}>
          <span data-slot="session-turn-diffs-toggle" onClick={() => setState("showAll", !showAll())}>
            {showAll() ? language.t("ui.sessionTurn.diffs.showLess") : language.t("ui.sessionTurn.diffs.showAll")}
          </span>
        </Show>
      </div>
      <div data-component="session-turn-diffs-content">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={expanded()}
          onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={visible()}>
            {(diff) => {
              const opened = createMemo(() => expanded().includes(diff.file))

              return (
                <Accordion.Item value={diff.file}>
                  <StickyAccordionHeader>
                    <Accordion.Trigger>
                      <DiffHoverCard diff={diff}>
                        <div data-slot="session-turn-diff-trigger">
                          <span data-slot="session-turn-diff-path" data-path={diff.file}>
                            <Show when={diff.file.includes("/")}>
                              <span data-slot="session-turn-diff-directory">{`\u202A${getDirectory(diff.file)}\u202C`}</span>
                            </Show>
                            <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                          </span>
                          <div data-slot="session-turn-diff-meta">
                            <span data-slot="session-turn-diff-changes">
                              <DiffChanges changes={diff} />
                            </span>
                            <span data-slot="session-turn-diff-chevron">
                              <Icon name="chevron-down" size="small" />
                            </span>
                          </div>
                        </div>
                      </DiffHoverCard>
                    </Accordion.Trigger>
                  </StickyAccordionHeader>
                  <Accordion.Content>
                    <Show when={opened()}>
                      <TimelineDiffView diff={diff} />
                    </Show>
                  </Accordion.Content>
                </Accordion.Item>
              )
            }}
          </For>
        </Accordion>
        <Show when={!showAll() && overflow() > 0}>
          <div data-slot="session-turn-diffs-more" onClick={() => setState("showAll", true)}>
            {language.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
          </div>
        </Show>
      </div>
    </div>
  )
}

function TimelineDiffView(props: { diff: SummaryDiff }) {
  const fileComponent = useFileComponent()
  const view = normalize(props.diff)

  return (
    <div data-slot="session-turn-diff-view" data-scrollable>
      <Dynamic component={fileComponent} mode="diff" fileDiff={view.fileDiff} />
    </div>
  )
}

// Hover diff popover (T10, D§3.10): 800ms hover on a file row floats a diff preview.
function DiffHoverCard(props: { diff: SummaryDiff; children: JSX.Element }) {
  return (
    <KobalteTooltip openDelay={800} closeDelay={100} placement="top" gutter={8}>
      <KobalteTooltip.Trigger as="div" class="min-w-0 w-full">
        {props.children}
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content class="z-[95] max-w-[min(560px,80vw)] max-h-80 overflow-auto rounded-xl border-[0.5px] border-border-weak-base bg-background-stronger shadow-xl">
          <div class="flex items-center justify-between gap-3 px-3 py-2 border-b-[0.5px] border-border-weak-base text-12-regular text-text-weak">
            <span class="truncate">{props.diff.file}</span>
            <DiffChanges changes={props.diff} />
          </div>
          <TimelineDiffView diff={props.diff} />
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  )
}
