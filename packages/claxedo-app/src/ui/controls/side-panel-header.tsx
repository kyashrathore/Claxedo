import { Show, type JSX } from "solid-js"
import { SidePanelTab } from "./side-panel-tab"
import { ClaxedoIcon } from "./claxedo-icon"

const CONTROL_CLASS =
  "relative flex size-6 items-center justify-center rounded-sm text-icon-weak-base transition-colors duration-100 hover:bg-surface-base-hover hover:text-icon-base pointer-coarse:size-11"

type SidePanelHeaderProps = (
  | {
      readonly tabs: JSX.Element
    }
  | {
      readonly tab: {
        readonly label: string
        readonly icon: JSX.Element
        readonly closeLabel: string
        readonly onClose: () => void
      }
    }
) & {
  readonly controls: SidePanelControlsProps
  readonly toolbar?: JSX.Element
  readonly testId?: string
}

export function SidePanelHeader(props: SidePanelHeaderProps): JSX.Element {
  return (
    <div class="shrink-0 bg-background-base">
      <div
        data-testid={props.testId}
        class="relative flex h-9 shrink-0 items-center overflow-hidden border-b border-border-weaker-base bg-background-base pointer-coarse:h-11"
      >
        <div class="flex h-full min-w-0 flex-1 items-center overflow-hidden">
          {"tab" in props ? <SidePanelTab {...props.tab} selected closable /> : props.tabs}
        </div>
        <div class="flex h-full shrink-0 items-center pr-1">
          <SidePanelControls {...props.controls} />
        </div>
      </div>
      {props.toolbar}
    </div>
  )
}

type SidePanelControlsProps = {
  readonly phone: boolean
  readonly fullWidth: boolean
  readonly maximizeLabel: string
  readonly closeLabel: string
  readonly onMaximize: () => void
  readonly onClose: () => void
  readonly closeTestId?: string
}

function SidePanelControls(props: SidePanelControlsProps): JSX.Element {
  return (
    <div class="flex shrink-0 items-center gap-0.5 pl-1">
      <Show when={!props.phone}>
        <button
          type="button"
          class={CONTROL_CLASS}
          data-icon-interaction="binary"
          aria-label={props.maximizeLabel}
          title={props.maximizeLabel}
          aria-pressed={props.fullWidth}
          onClick={() => props.onMaximize()}
        >
          <ClaxedoIcon name={props.fullWidth ? "collapse" : "expand"} size="small" />
        </button>
      </Show>
      <SidePanelToggle open label={props.closeLabel} testId={props.closeTestId} onToggle={props.onClose} />
    </div>
  )
}

export function SidePanelToggle(props: {
  readonly open: boolean
  readonly label: string
  readonly testId?: string
  readonly onToggle: () => void
  readonly onPointerDown?: JSX.EventHandler<HTMLButtonElement, PointerEvent>
}): JSX.Element {
  return (
    <button
      type="button"
      class={CONTROL_CLASS}
      data-testid={props.testId}
      data-icon-interaction="binary"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.open}
      onPointerDown={props.onPointerDown}
      onClick={() => props.onToggle()}
    >
      <ClaxedoIcon name={props.open ? "layout-right-full" : "layout-right-partial"} size="small" />
    </button>
  )
}
