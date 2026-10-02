import type { Accessor, Component, JSX } from "solid-js"
import type { ComposerTextKey } from "../i18n"
import { ClaxedoIcon as Icon } from "@/ui"
import type { HarnessScopeInput, HarnessSelectionController } from "../harness/controller"
import type { PermissionModeGroups } from "../permission/permission-mode"
import type { PermissionModeOption } from "../permission/modes"
import type { SubmitBlock } from "../submit-block-reason"
import type { PromptInputMode } from "./editor-surface"
import { PromptSubmitControl } from "./submit-control"
import { PromptToolbarControls } from "./toolbar-controls"

export type PromptToolbarProps = {
  mode: Accessor<PromptInputMode>
  harnessPending: Accessor<boolean>
  commandKeybind: (id: string) => string | undefined
  fileInputRef: (el: HTMLInputElement) => void
  acceptedFileTypes: readonly string[]
  addAttachments: (files: File[]) => void
  attachStyle: Accessor<JSX.CSSProperties>
  pick: VoidFunction
  openCommands: VoidFunction
  openContext: VoidFunction
  enterShellMode: VoidFunction
  goalSelectable: Accessor<boolean>
  goalArmed: Accessor<boolean>
  armGoal: VoidFunction
  toggleGoal: VoidFunction
  approveEnabled: Accessor<boolean>
  permissionGroups: Accessor<PermissionModeGroups | undefined>
  permissionCurrent: Accessor<PermissionModeOption | undefined>
  onPermissionSelect: (option: PermissionModeOption) => void
  onPermissionOpen: () => void
  harnessController: Accessor<HarnessSelectionController | undefined>
  harnessScope: Accessor<string>
  harnessScopeInput: Accessor<HarnessScopeInput>
  active: Accessor<boolean>
  controlStyle: Accessor<JSX.CSSProperties>
  sessionLocked: Accessor<boolean>
  showAgentSelector: Accessor<boolean>
  agentNames: Accessor<string[]>
  currentAgentName: Accessor<string>
  onAgentSelect: (value: string) => void
  stoppable: Accessor<boolean>
  booting: Accessor<boolean>
  working: Accessor<boolean>
  blank: Accessor<boolean>
  bootText: Accessor<string>
  submitDisabled: Accessor<boolean>
  submitExcludeFromTab: Accessor<boolean>
  submitBlock: Accessor<SubmitBlock | null>
  onChooseModel: VoidFunction
  readOnly: Accessor<boolean>
  t: (key: ComposerTextKey) => string
}

export const PromptToolbar: Component<PromptToolbarProps> = (props) => {
  const submitTip = () => {
    if (props.booting()) {
      return (
        <div class="flex items-center gap-2">
          <span>{props.bootText()}</span>
        </div>
      )
    }
    if (props.stoppable() && props.blank()) {
      return (
        <div class="flex items-center gap-2">
          <span>{props.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-12-medium text-2xs!">{props.t("common.key.esc")}</span>
        </div>
      )
    }
    return (
      <div class="flex items-center gap-2">
        <span>{props.t("prompt.action.send")}</span>
        <Icon name="enter" size="small" class="text-icon-base" />
      </div>
    )
  }

  return (
    <div data-slot="composer-toolbar" class="flex h-11 items-center gap-1 px-2">
      <PromptToolbarControls
        fileAttachmentInput={() => (
          <input
            ref={props.fileInputRef}
            type="file"
            multiple
            accept={props.acceptedFileTypes.join(",")}
            class="hidden"
            onChange={(e) => {
              const list = e.currentTarget.files
              if (list) props.addAttachments(Array.from(list))
              e.currentTarget.value = ""
            }}
          />
        )}
        addTitle={props.t("prompt.action.add")}
        attachTitle={props.t("prompt.action.imagesAndFiles")}
        attachKeybind={props.commandKeybind("file.attach") ?? ""}
        attachStyle={props.attachStyle}
        onAttach={props.pick}
        commandsTitle={props.t("prompt.action.commands")}
        onCommands={props.openCommands}
        contextTitle={props.t("prompt.action.context")}
        onContext={props.openContext}
        shellTitle={props.t("prompt.action.shellCommand")}
        onEnterShell={props.enterShellMode}
        goalTitle={props.t("prompt.action.goal")}
        clearGoalTitle={props.t("prompt.action.clearGoal")}
        goalSelectable={props.goalSelectable}
        goalArmed={props.goalArmed}
        onGoal={props.armGoal}
        onGoalToggle={props.toggleGoal}
        planModeTitle={props.t("prompt.action.planMode")}
        agentGroupTitle={props.t("prompt.action.agentGroup")}
        approveEnabled={props.approveEnabled}
        permissionGroups={props.permissionGroups}
        permissionCurrent={props.permissionCurrent}
        onPermissionSelect={props.onPermissionSelect}
        onPermissionOpen={props.onPermissionOpen}
        approveTitle={props.t("prompt.action.approveForMe")}
        mode={props.mode}
        harnessPending={props.harnessPending}
        readOnly={props.readOnly}
        harnessController={props.harnessController}
        harnessScope={props.harnessScope}
        harnessScopeInput={props.harnessScopeInput}
        active={props.active}
        controlStyle={props.controlStyle}
        sessionLocked={props.sessionLocked}
        showAgentSelector={props.showAgentSelector}
        agentNames={props.agentNames}
        currentAgentName={props.currentAgentName}
        onAgentSelect={props.onAgentSelect}
      />
      <PromptSubmitControl
        busy={props.stoppable}
        booting={props.booting}
        working={props.working}
        blank={props.blank}
        tip={submitTip}
        bootText={props.bootText}
        mode={props.mode}
        disabled={props.submitDisabled}
        excludeFromTab={props.submitExcludeFromTab}
        block={props.submitBlock}
        onChooseModel={props.onChooseModel}
        stopLabel={props.t("prompt.action.stop")}
        sendLabel={props.t("prompt.action.send")}
      />
    </div>
  )
}
