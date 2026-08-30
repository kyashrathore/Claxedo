import { type Accessor, type JSX, Show } from "solid-js"
import type { PickerState } from "@/features/session/ui/model/select-model"
import type { ModelKey } from "@/features/session/composer/model-strategy"
import { AgentHarnessSelector } from "@/features/session/ui/controls/agent-harness-selector"
import type { HarnessSelectionController } from "@/features/session/harness/controller"
import { PromptAddMenu } from "@/features/session/composer/ui/add-menu"
import { PromptPermissionControl } from "@/features/session/composer/ui/permission-control"
import { openCodeDraftLabels } from "@/features/session/composer/open-code-draft-default"
import type { PermissionModeGroups } from "@/features/session/composer/permission-mode"
import type { PermissionModeOption } from "@/features/session/permission/modes"
import type { SessionRef } from "@/platform/identity/session-ref"

/**
 * The composer's bottom row. Two clusters instead of one left-aligned strip:
 * actions and session policy on the left (`+`, auto-accept), the "who answers"
 * configuration on the right (harness, model, effort), with the submit control
 * following in `frame.tsx`. The agent and effort chips that used to sit inline
 * here are gone — agent/plan-mode moved into the `+` menu, and effort merged
 * into the model control.
 */
export function PromptToolbarControls(props: {
  fileAttachmentInput: () => JSX.Element
  addTitle: string
  attachTitle: string
  attachKeybind: string
  attachStyle: Accessor<JSX.CSSProperties>
  onAttach: VoidFunction
  commandsTitle: string
  onCommands: VoidFunction
  contextTitle: string
  onContext: VoidFunction
  shellTitle: string
  onEnterShell: VoidFunction
  planModeTitle: string
  agentGroupTitle: string
  approveEnabled: Accessor<boolean>
  approveTitle: string
  permissionGroups: Accessor<PermissionModeGroups | undefined>
  permissionCurrent: Accessor<PermissionModeOption | undefined>
  onPermissionSelect: (option: PermissionModeOption) => void
  mode: Accessor<"normal" | "shell">
  harnessPending: Accessor<boolean>
  harnessController: Accessor<HarnessSelectionController | undefined>
  harnessDirectory: Accessor<string | undefined>
  harnessSessionId: Accessor<string | undefined>
  sessionRef: Accessor<SessionRef | undefined>
  surfaceId: Accessor<string | undefined>
  draftId: Accessor<string | undefined>
  active: Accessor<boolean>
  controlStyle: Accessor<JSX.CSSProperties>
  sessionLocked: Accessor<boolean>
  modelLocked: Accessor<boolean>
  showAgentSelector: Accessor<boolean>
  agentNames: Accessor<string[]>
  currentAgentName: Accessor<string>
  onAgentSelect: (value: string) => void
  providerLoading: Accessor<boolean>
  modelLabel: Accessor<string>
  model: Accessor<PickerState>
  showVariantSelector: Accessor<boolean>
  variantTitle: string
  variantKeybind: string
  variants: Accessor<string[]>
  currentVariant: Accessor<string | undefined>
  variantLabel: (value: string) => string
  onVariantSelect: (value: string) => void
}) {
  const addDisabled = () => props.mode() !== "normal" || props.harnessPending()

  return (
    <div data-slot="composer-controls" class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      <PromptAddMenu
        fileAttachmentInput={props.fileAttachmentInput}
        disabled={addDisabled}
        triggerStyle={props.attachStyle}
        triggerLabel={props.addTitle}
        attachLabel={props.attachTitle}
        attachKeybind={props.attachKeybind}
        onAttach={props.onAttach}
        commandsLabel={props.commandsTitle}
        onCommands={props.onCommands}
        contextLabel={props.contextTitle}
        onContext={props.onContext}
        shellLabel={props.shellTitle}
        onEnterShell={props.onEnterShell}
        agentNames={props.agentNames}
        currentAgentName={props.currentAgentName}
        onAgentSelect={props.onAgentSelect}
        showAgentControls={() => props.showAgentSelector() && !props.harnessPending()}
        agentGroupLabel={props.agentGroupTitle}
        planModeLabel={props.planModeTitle}
      />
      <PromptPermissionControl
        enabled={() => {
          if (!props.approveEnabled() || !props.active() || props.harnessPending()) return false
          const groups = props.permissionGroups()
          if (!groups) return false
          const current = props.permissionCurrent()
          if (!current?.id) return false
          // Hide the trigger until the offered rows include the resolved mode.
          // Otherwise a default Claxedo id can flash on an opencode-shaped draft
          // while Codex modes are still loading (tier-real behavior 13).
          const offered = [...groups.claxedo, ...groups.harness.rows]
          if (offered.length === 0) return false
          return offered.some((row) => row.option.id === current.id)
        }}
        disabled={addDisabled}
        style={props.attachStyle}
        groups={props.permissionGroups}
        current={props.permissionCurrent}
        label={props.approveTitle}
        onSelect={props.onPermissionSelect}
      />
      <div data-slot="composer-selection-controls" class="ml-auto flex min-w-0 items-center gap-1">
        <Show when={props.harnessController()}>
          {(controller) => (
            <AgentHarnessSelector
              harnessController={controller()}
              directory={props.harnessDirectory()}
              sessionId={props.harnessSessionId()}
              sessionRef={props.sessionRef()}
              surfaceId={props.surfaceId()}
              draftId={props.draftId()}
              active={props.active()}
              triggerStyle={props.controlStyle()}
              sessionLocked={props.sessionLocked()}
              modelLocked={props.modelLocked()}
              openCodeModel={() => {
                const current = props.model().current()
                const variant = props.currentVariant()
                return current ? {
                  providerID: current.provider.id,
                  modelID: current.id,
                  ...(variant && variant !== "default" ? { variant } : {}),
                } satisfies ModelKey : undefined
              }}
              openCodeModelLabels={() => {
                const current = props.model().current()
                return openCodeDraftLabels(
                  current ? { providerID: current.provider.id, modelID: current.id } : undefined,
                  props.model().list(),
                )
              }}
              openCode={{
                model: props.model,
                label: props.modelLabel,
                loading: props.providerLoading,
                showVariantSelector: props.showVariantSelector,
                variants: props.variants,
                currentVariant: props.currentVariant,
                variantLabel: props.variantLabel,
                onVariantSelect: props.onVariantSelect,
              }}
            />
          )}
        </Show>
      </div>
    </div>
  )
}
