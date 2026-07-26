import { type Accessor, type JSX, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Select } from "@opencode-ai/ui/select"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ModelSelectorPopover, type PickerState } from "@/features/session/ui/model/select-model"
import { COMPOSER_COMPACT_MENU_CLASS, COMPOSER_MENU_CLASS } from "@/features/session/composer/ui/menu-metrics"

/**
 * Model and thinking-effort read as one control: `Sonnet 5 High ⌄`.
 *
 * They are still two hit targets, not one — the model half opens the searchable
 * model popover, the effort half opens the variant list — because the two lists
 * have nothing in common and merging them into a single popover would bury the
 * model search under a mode switch. What the redesign removes is the *visual*
 * split: the model half drops its chevron whenever the effort half is present,
 * so the pair carries exactly one, at the right-hand edge, and the two labels
 * sit tight against each other with the model in `text-base` and the effort in
 * `text-faint`.
 */
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
  showVariantSelector: Accessor<boolean>
  variantTitle: string
  variantKeybind: string
  variants: Accessor<string[]>
  currentVariant: Accessor<string | undefined>
  variantLabel: (value: string) => string
  onVariantSelect: (value: string) => void
}) {
  const buttonClass =
    "min-w-0 max-w-[220px] max-md:max-w-[128px] justify-start text-[13px] font-[440] leading-4 text-v2-text-text-base group"

  const content = () => (
    <>
      <Icon name="brain" size="small" class="composer-compact-only shrink-0 text-v2-icon-icon-base" />
      <Show when={props.providerID()}>
        <ProviderIcon
          id={props.providerID()!}
          class="composer-model-provider size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
          style={{ "will-change": "opacity", transform: "translateZ(0)" }}
        />
      </Show>
      <span data-slot="composer-control-label" class="truncate">{props.label()}</span>
      {/* One chevron per control: the effort half owns it when it is rendered. */}
      <Show when={!props.providerLoading() && !props.showVariantSelector()}>
        <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      </Show>
    </>
  )

  return (
    <Show when={!props.harnessMode()}>
      <div data-component="prompt-model-control" class="flex min-w-0 items-center gap-1">
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
              contentClass={COMPOSER_MENU_CLASS}
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
        <Show when={props.showVariantSelector()}>
          <TooltipKeybind
            placement="top"
            gutter={4}
            title={props.variantTitle}
            keybind={props.variantKeybind}
          >
            <Select
              size="normal"
              options={props.variants()}
              current={props.currentVariant() ?? "default"}
              label={props.variantLabel}
              onSelect={(value) => {
                // Kobalte's Select re-fires onChange with the CURRENT value when
                // its options collection changes identity (an internal
                // selection-sync effect, not a user pick). Propagating that no-op
                // would spuriously re-set the variant and yank focus into the
                // composer (`restoreFocus`), closing whatever menu the user has
                // open. Only forward actual changes.
                if (value !== undefined && value !== (props.currentVariant() ?? "default")) props.onVariantSelect(value)
              }}
              class="capitalize max-w-[120px] max-md:hidden"
              valueClass="truncate text-[13px] font-[440] leading-4 text-v2-text-text-faint"
              triggerStyle={props.controlStyle()}
              contentClass={COMPOSER_COMPACT_MENU_CLASS}
              triggerProps={{ "data-action": "prompt-model-variant" }}
              variant="ghost"
            >
              {(value) => (
                <span class="flex min-w-0 items-center gap-1.5">
                  <Icon name="sliders" size="small" class="composer-compact-only shrink-0" />
                  <span data-slot="composer-control-label" class="truncate">
                    {props.variantLabel(value ?? "default")}
                  </span>
                </span>
              )}
            </Select>
          </TooltipKeybind>
        </Show>
      </div>
    </Show>
  )
}
