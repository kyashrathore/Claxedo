import { type Accessor, type JSX, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import type { PickerState } from "@/features/session/ui/model/select-model"
import { AgentHarnessSelector } from "@/features/session/ui/controls/agent-harness-selector"
import type { HarnessSelectionController } from "@/features/session/harness/controller"
import { PromptModelControl } from "@/features/session/composer/ui/model-control"

export function PromptToolbarControls(props: {
  fileAttachmentInput: () => JSX.Element
  attachTitle: string
  attachKeybind: string
  attachStyle: Accessor<JSX.CSSProperties>
  onAttach: VoidFunction
  mode: Accessor<"normal" | "shell">
  harnessPending: Accessor<boolean>
  harnessController: Accessor<HarnessSelectionController | undefined>
  harnessDirectory: Accessor<string | undefined>
  harnessSessionId: Accessor<string | undefined>
  surfaceId: Accessor<string | undefined>
  draftId: Accessor<string | undefined>
  active: Accessor<boolean>
  controlStyle: Accessor<JSX.CSSProperties>
  sessionLocked: Accessor<boolean>
  showAgentSelector: Accessor<boolean>
  agentTitle: string
  agentKeybind: string
  agentNames: Accessor<string[]>
  currentAgentName: Accessor<string>
  onAgentSelect: (value: string) => void
  agentTriggerStyle: Accessor<JSX.CSSProperties>
  modelHarnessMode: Accessor<boolean>
  paidProviderCount: Accessor<number>
  providerLoading: Accessor<boolean>
  providerID: Accessor<string | undefined>
  modelLabel: Accessor<string>
  model: Accessor<PickerState>
  modelTitle: string
  modelKeybind: string
  onUnpaidModelClick: VoidFunction
  onModelClose: VoidFunction
  showVariantSelector: Accessor<boolean>
  variantTitle: string
  variantKeybind: string
  variants: Accessor<string[]>
  currentVariant: Accessor<string | undefined>
  variantLabel: (value: string) => string
  onVariantSelect: (value: string) => void
}) {
  return (
    <div class="flex min-w-0 flex-1 items-center gap-0 overflow-hidden">
      {props.fileAttachmentInput()}
      <TooltipKeybind
        placement="top"
        title={props.attachTitle}
        keybind={props.attachKeybind}
      >
        <IconButton
          data-action="prompt-attach"
          type="button"
          icon="plus"
          variant="ghost"
          class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted"
          style={props.attachStyle()}
          onClick={props.onAttach}
          disabled={props.mode() !== "normal" || props.harnessPending()}
          tabIndex={props.mode() === "normal" && !props.harnessPending() ? undefined : -1}
          aria-label={props.attachTitle}
        />
      </TooltipKeybind>
      <Show when={props.harnessController()}>
        {(controller) => (
          <AgentHarnessSelector
            harnessController={controller()}
            directory={props.harnessDirectory()}
            sessionId={props.harnessSessionId()}
            surfaceId={props.surfaceId()}
            draftId={props.draftId()}
            active={props.active()}
            triggerStyle={props.controlStyle()}
            sessionLocked={props.sessionLocked()}
          />
        )}
      </Show>
      <Show when={props.showAgentSelector()}>
        <TooltipKeybind
          placement="top"
          gutter={4}
          title={props.agentTitle}
          keybind={props.agentKeybind}
        >
          <Select
            size="normal"
            options={props.agentNames()}
            current={props.currentAgentName()}
            onSelect={(value) => {
              if (value !== undefined) props.onAgentSelect(value)
            }}
            classList={{
              "capitalize max-w-[160px] max-md:shrink-0": true,
              "text-v2-text-text-faint": !props.harnessPending(),
              "text-text-weak": props.harnessPending(),
            }}
            valueClass="truncate text-[13px] font-[440] leading-4"
            triggerStyle={props.agentTriggerStyle()}
            triggerProps={{ "data-action": "prompt-agent" }}
            variant="ghost"
            disabled={props.harnessPending()}
          />
        </TooltipKeybind>
      </Show>
      <PromptModelControl
        harnessMode={props.modelHarnessMode}
        paidProviderCount={props.paidProviderCount}
        providerLoading={props.providerLoading}
        providerID={props.providerID}
        label={props.modelLabel}
        model={props.model}
        controlStyle={props.controlStyle}
        chooseTitle={props.modelTitle}
        chooseKeybind={props.modelKeybind}
        onUnpaidClick={props.onUnpaidModelClick}
        onClose={props.onModelClose}
      />
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
              if (value !== undefined) props.onVariantSelect(value)
            }}
            class="capitalize max-w-[160px] max-md:hidden"
            valueClass="truncate text-[13px] font-[440] leading-4 text-v2-text-text-faint"
            triggerStyle={props.controlStyle()}
            triggerProps={{ "data-action": "prompt-model-variant" }}
            variant="ghost"
          />
        </TooltipKeybind>
      </Show>
    </div>
  )
}
