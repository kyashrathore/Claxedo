import { Show, type Accessor, type Component, type JSX } from "solid-js"
import type { ComposerTextKey } from "../i18n"
import { ClaxedoIcon as Icon, DockShellForm } from "@/ui"
import type { ImagePart as ImageAttachmentPart } from "../model"
import { PromptContextItems } from "./context-items"
import { PromptDragOverlay } from "./drag-overlay"
import { PromptImageAttachments } from "./image-attachments"
import { firstMarkNumber, type NumberedImageMark } from "../marks/marks"
import {
  PromptPopover,
  PROMPT_POPOVER_LISTBOX_ID,
  promptAtOptionId,
  promptSlashOptionId,
  type AtOption,
  type SlashCommand,
} from "./slash-popover"
import {
  ComposerNoticeProvider,
  ComposerNoticeRow,
  createComposerNoticeChannel,
  useComposerNoticeChannel,
} from "./composer-notice"
import { PromptSubmitControl } from "./submit-control"
import type { SubmitBlock } from "../submit-block-reason"
import { PromptToolbarControls } from "./toolbar-controls"
import type { SessionStatusStage as SessionStatusStageValue } from "./session-status-stage"
import type { HarnessScopeInput, HarnessSelectionController } from "../harness/controller"
import type { PermissionModeGroups } from "../permission/permission-mode"
import type { PermissionModeOption } from "../permission/modes"

type PromptInputMode = "normal" | "shell"
type PromptDraggingType = "image" | "@mention" | null
type PromptContextItem = Parameters<typeof PromptContextItems>[0]["items"][number]

export const PromptInputFrame: Component<{
  rootRef: (el: HTMLDivElement) => void
  editorRef: (el: HTMLDivElement) => void
  scrollRef: (el: HTMLDivElement) => void
  className?: string
  newSession: Accessor<boolean>
  mode: Accessor<PromptInputMode>
  dirty: Accessor<boolean>
  collapsed: Accessor<boolean>
  draggingType: Accessor<PromptDraggingType>
  designPlaceholder: Accessor<string>
  handleRootFocusIn: VoidFunction
  handleSubmit: JSX.EventHandlerUnion<HTMLFormElement, SubmitEvent>
  harnessPending: Accessor<boolean>
  onEditorFocus: JSX.EventHandlerUnion<HTMLDivElement, FocusEvent>
  onEditorInput: JSX.EventHandlerUnion<HTMLDivElement, InputEvent>
  onEditorPaste: JSX.EventHandlerUnion<HTMLDivElement, ClipboardEvent>
  onCompositionStart: JSX.EventHandlerUnion<HTMLDivElement, CompositionEvent>
  onCompositionEnd: JSX.EventHandlerUnion<HTMLDivElement, CompositionEvent>
  onEditorBlur: JSX.EventHandlerUnion<HTMLDivElement, FocusEvent>
  onEditorKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
  focusEditor: VoidFunction
  popover: "at" | "slash" | null
  documentPicker: boolean
  documentNotice?: string
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybind: (id: string) => string | undefined
  contextItems: PromptContextItem[]
  contextActive: (item: PromptContextItem) => boolean
  openComment: (item: PromptContextItem) => void
  removeContextItem: (item: PromptContextItem) => void
  imageAttachments: ImageAttachmentPart[]
  imageMarks: NumberedImageMark[]
  openImageMarks: (attachment: ImageAttachmentPart, focusIndex?: number) => void
  removeImageMark: (entry: NumberedImageMark) => void
  removeAttachment: (id: string) => void
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
  statusStage: Accessor<SessionStatusStageValue>
  stoppable: Accessor<boolean>
  abort: VoidFunction
  onRetry: Accessor<(() => void) | undefined>
  booting: Accessor<boolean>
  working: Accessor<boolean>
  blank: Accessor<boolean>
  bootText: Accessor<string>
  submitDisabled: Accessor<boolean>
  submitExcludeFromTab: Accessor<boolean>
  submitBlock: Accessor<SubmitBlock | null>
  onChooseModel: VoidFunction
  workspaceRoleBlocked: Accessor<boolean>
  t: (key: ComposerTextKey) => string
}> = (props) => {
  const activeDescendant = () => {
    if (props.popover === "at" && props.atActive) return promptAtOptionId(props.atActive)
    if (props.popover === "slash" && props.slashActive) return promptSlashOptionId(props.slashActive)
    return undefined
  }

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

  const inherited = useComposerNoticeChannel()
  const own = inherited ? undefined : createComposerNoticeChannel()
  const notice = () => own?.current()

  return (
  <ComposerNoticeProvider channel={inherited ?? own!}>
  <div
    ref={props.rootRef}
    data-component="composer-frame"
    classList={{
      "relative size-full flex flex-col gap-0": true,
      "_max-h-[320px]": !props.newSession(),
    }}
    onFocusIn={props.handleRootFocusIn}
  >
    <PromptPopover
      popover={props.popover}
      documentPicker={props.documentPicker}
      documentNotice={props.documentNotice}
      setSlashPopoverRef={props.setSlashPopoverRef}
      atFlat={props.atFlat}
      atActive={props.atActive}
      atKey={props.atKey}
      setAtActive={props.setAtActive}
      onAtSelect={props.onAtSelect}
      slashFlat={props.slashFlat}
      slashActive={props.slashActive}
      setSlashActive={props.setSlashActive}
      onSlashSelect={props.onSlashSelect}
      commandKeybind={props.commandKeybind}
      t={props.t}
    />
    <Show when={props.documentNotice}>
      <div role="status" aria-live="polite" class="px-3 py-1 text-12-regular text-text-weak">
        {props.documentNotice}
      </div>
    </Show>
    <ComposerNoticeRow notice={notice()} />
    <DockShellForm
      data-component={props.newSession() ? "session-new-composer" : "session-composer"}
      data-surface="composer"
      data-dock-border-underlay="v2"
      data-composer-collapsed={props.collapsed() || undefined}
      onSubmit={props.handleSubmit}
      classList={{
        "group/prompt-input min-h-[96px] w-full rounded-xl bg-v2-background-bg-base": true,
        "relative z-10 -mt-2": !!notice(),
        "border-icon-info-active border-dashed": props.draggingType() !== null,
        [props.className ?? ""]: !!props.className,
      }}
    >
      <PromptDragOverlay
        type={props.draggingType()}
        label={props.t(props.draggingType() === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label")}
      />
      <PromptContextItems
        items={props.contextItems}
        active={props.contextActive}
        openComment={props.openComment}
        remove={props.removeContextItem}
        imageMarks={props.imageMarks}
        openImageMark={(entry) => {
          const attachment = props.imageAttachments.find((part) => part.id === entry.imageId)
          if (attachment) props.openImageMarks(attachment, entry.index)
        }}
        removeImageMark={props.removeImageMark}
        t={props.t}
      />
      <PromptImageAttachments
        attachments={props.imageAttachments}
        firstMarkNumber={(id) => firstMarkNumber(props.imageAttachments, id)}
        onOpen={(attachment) => props.openImageMarks(attachment)}
        onRemove={props.removeAttachment}
        removeLabel={props.t("prompt.attachment.remove")}
        markLabel={props.t("prompt.imageMarks.open")}
      />
      <div
        data-slot="composer-editor"
        class="relative min-h-[52px]"
        onMouseDown={(e) => {
          const target = e.target
          if (!(target instanceof HTMLElement)) return
          if (target.closest('[data-action="prompt-attach"], [data-action="prompt-submit"]')) return
          props.focusEditor()
        }}
      >
        <div class="relative max-h-[180px] overflow-y-auto no-scrollbar" ref={props.scrollRef}>
          <div
            data-component="prompt-input"
            ref={props.editorRef}
            onFocus={props.onEditorFocus}
            role={props.popover !== null ? "combobox" : "textbox"}
            aria-multiline={props.popover === null ? "true" : undefined}
            aria-expanded={props.popover !== null ? true : undefined}
            aria-controls={props.popover !== null ? PROMPT_POPOVER_LISTBOX_ID : undefined}
            aria-autocomplete={props.popover !== null ? "list" : undefined}
            aria-activedescendant={activeDescendant()}
            aria-label={props.designPlaceholder()}
            contenteditable="true"
            autocapitalize={props.mode() === "normal" ? "sentences" : "off"}
            autocorrect={props.mode() === "normal" ? "on" : "off"}
            spellcheck={props.mode() === "normal"}
            inputMode="text"
            // @ts-expect-error
            autocomplete="off"
            onInput={props.onEditorInput}
            onPaste={props.onEditorPaste}
            onCompositionStart={props.onCompositionStart}
            onCompositionEnd={props.onCompositionEnd}
            onBlur={props.onEditorBlur}
            onKeyDown={props.onEditorKeyDown}
            classList={{
              "select-text": true,
              "min-h-[52px] w-full px-4 pt-4 pb-2 focus:outline-none whitespace-pre-wrap leading-5 text-compact font-body text-v2-text-text-base [font-family:var(--font-family-sans)]": true,
              "[&_[data-type=file]]:text-syntax-property": true,
              "[&_[data-type=agent]]:text-syntax-type": true,
              "font-mono!": props.mode() === "shell",
            }}
          />
          <div
            data-component={props.newSession() ? undefined : "session-composer-text"}
            class="absolute top-0 inset-x-0 px-4 pt-4 pointer-events-none whitespace-nowrap truncate leading-5 text-compact font-body text-v2-text-text-faint [font-family:var(--font-family-sans)]"
            classList={{ "font-mono!": props.mode() === "shell", hidden: props.dirty() }}
          >
            {props.designPlaceholder()}
          </div>
        </div>
      </div>
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
          approveTitle={props.t("prompt.action.approveForMe")}
          mode={props.mode}
          harnessPending={props.harnessPending}
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
          stage={props.statusStage}
          busy={props.stoppable}
          onCancel={props.abort}
          onRetry={props.onRetry}
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
          readOnlyBlocked={props.workspaceRoleBlocked}
          stopLabel={props.t("prompt.action.stop")}
          sendLabel={props.t("prompt.action.send")}
          readOnlyLabel={props.t("prompt.action.readOnlyWorkspace")}
        />
      </div>
    </DockShellForm>
  </div>
  </ComposerNoticeProvider>
  )
}
