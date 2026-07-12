import { type Accessor, type JSX, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { SessionStatusStage, type SessionStatusStage as SessionStatusStageValue } from "@/features/session/ui/components/session-status-stage"

export function PromptSubmitControl(props: {
  stage: Accessor<SessionStatusStageValue>
  busy: Accessor<boolean>
  onCancel: VoidFunction
  onRetry: Accessor<(() => void) | undefined>
  booting: Accessor<boolean>
  working: Accessor<boolean>
  blank: Accessor<boolean>
  tip: Accessor<JSX.Element>
  bootText: Accessor<string>
  mode: Accessor<"normal" | "shell">
  disabled: Accessor<boolean>
  excludeFromTab: Accessor<boolean>
  readOnlyBlocked: Accessor<boolean>
  sendLabel: string
  stopLabel: string
  readOnlyLabel: string
}) {
  return (
    <>
      <SessionStatusStage
        stage={props.stage()}
        busy={props.busy()}
        onCancel={props.onCancel}
        onRetry={props.onRetry()}
      />
      <Tooltip placement="top" inactive={!props.booting() && !props.working() && props.blank()} value={props.tip()}>
        <div class="flex items-center gap-2">
          <Show when={props.booting()}>
            <div class="flex items-center gap-1.5 rounded-md border border-border-base bg-surface-raised-base px-2 py-1 text-12-medium text-text-weak">
              <Spinner class="size-3.5 shrink-0" />
              <span>{props.bootText()}</span>
            </div>
          </Show>
          <IconButton
            data-action="prompt-submit"
            type="submit"
            disabled={props.disabled()}
            tabIndex={props.excludeFromTab() ? -1 : undefined}
            icon={props.busy() ? "stop" : props.mode() === "shell" ? "arrow-undo-down" : "arrow-up"}
            variant="primary"
            class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted shadow-[var(--v2-elevation-button-contrast)] disabled:opacity-50"
            style={{
              "background-image":
                "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(90deg,var(--v2-background-bg-contrast) 0%,var(--v2-background-bg-contrast) 100%)",
            }}
            aria-label={
              props.busy()
                ? props.stopLabel
                : props.booting()
                  ? props.bootText()
                  : props.readOnlyBlocked() ? props.readOnlyLabel : props.sendLabel
            }
          />
        </div>
      </Tooltip>
    </>
  )
}
