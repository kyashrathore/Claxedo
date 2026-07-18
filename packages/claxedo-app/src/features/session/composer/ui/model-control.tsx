import { type Accessor, type JSX, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ModelSelectorPopover, type PickerState } from "@/features/session/ui/model/select-model"

export function PromptModelControl(props: {
  harnessMode: Accessor<boolean>
  paidProviderCount: Accessor<number>
  providerLoading: Accessor<boolean>
  providerID: Accessor<string | undefined>
  label: Accessor<string>
  model: Accessor<PickerState>
  connectRequired: Accessor<boolean>
  onConnect: VoidFunction
  controlStyle: Accessor<JSX.CSSProperties>
  chooseTitle: string
  chooseKeybind: string
  onUnpaidClick: VoidFunction
  onClose: VoidFunction
}) {
  const buttonClass =
    "min-w-0 max-w-[220px] max-md:max-w-[128px] justify-start text-[13px] font-[440] leading-4 text-v2-text-text-faint group"

  const content = () => (
    <>
      <Show when={props.providerID()}>
        <ProviderIcon
          id={props.providerID()!}
          class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
          style={{ "will-change": "opacity", transform: "translateZ(0)" }}
        />
      </Show>
      <span class="truncate">{props.label()}</span>
      <Show when={!props.providerLoading()}>
        <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      </Show>
    </>
  )

  return (
    <Show when={!props.harnessMode()}>
      <Show
        when={!props.connectRequired() && props.paidProviderCount() > 0}
        fallback={
          <TooltipKeybind
            placement="top"
            gutter={4}
            title={props.chooseTitle}
            keybind={props.chooseKeybind}
          >
            <Button
              data-action="prompt-model"
              as="div"
              variant="ghost"
              size="normal"
              class={buttonClass}
              style={props.controlStyle()}
              aria-disabled={props.providerLoading()}
              aria-label={props.connectRequired() ? props.label() : undefined}
              onClick={() => {
                if (props.providerLoading()) return
                if (props.connectRequired()) {
                  props.onConnect()
                  return
                }
                props.onUnpaidClick()
              }}
            >
              {content()}
            </Button>
          </TooltipKeybind>
        }
      >
        <TooltipKeybind
          placement="top"
          gutter={4}
          title={props.chooseTitle}
          keybind={props.chooseKeybind}
        >
          <ModelSelectorPopover
            model={props.model()}
            triggerAs={Button}
            triggerProps={{
              variant: "ghost",
              size: "normal",
              style: props.controlStyle(),
              class: buttonClass,
              "data-action": "prompt-model",
              disabled: props.providerLoading(),
            }}
            onClose={props.onClose}
          >
            {content()}
          </ModelSelectorPopover>
        </TooltipKeybind>
      </Show>
    </Show>
  )
}
