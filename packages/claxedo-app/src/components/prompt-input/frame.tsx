import type { Accessor, Component, JSX } from "solid-js"
import { DockShellForm } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import type { PickerState } from "@claxedo/components/dialogs/select-model"
import { DialogSelectModelUnpaid } from "@claxedo/components/dialogs/select-model-unpaid"
import type { ImageAttachmentPart } from "@/context/prompt"
import { PromptContextItems } from "@/components/prompt-input/context-items"
import { PromptDragOverlay } from "@/components/prompt-input/drag-overlay"
import { PromptImageAttachments } from "@/components/prompt-input/image-attachments"
import {
  PromptPopover,
  PROMPT_POPOVER_LISTBOX_ID,
  promptAtOptionId,
  promptSlashOptionId,
  type AtOption,
  type SlashCommand,
} from "@/components/prompt-input/slash-popover"
import { PromptSubmitControl } from "@/components/prompt-input/submit-control"
import { PromptToolbarControls } from "@/components/prompt-input/toolbar-controls"
import type { SessionStatusStage as SessionStatusStageValue } from "@claxedo/claxedo-ui/components/session-status-stage"
import type { HarnessSelectionController } from "@claxedo/session-client/harness/controller"

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
  removeAttachment: (id: string) => void
  fileInputRef: (el: HTMLInputElement) => void
  acceptedFileTypes: readonly string[]
  addAttachments: (files: File[]) => void
  attachStyle: Accessor<JSX.CSSProperties>
  pick: VoidFunction
  harnessController: Accessor<HarnessSelectionController | undefined>
  harnessDirectory: Accessor<string | undefined>
  harnessSessionId: Accessor<string | undefined>
  surfaceId: Accessor<string | undefined>
  draftId: Accessor<string | undefined>
  active: Accessor<boolean>
  controlStyle: Accessor<JSX.CSSProperties>
  sessionLocked: Accessor<boolean>
  showAgentSelector: Accessor<boolean>
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
  onModelClose: VoidFunction
  showVariantSelector: Accessor<boolean>
  variants: Accessor<string[]>
  currentVariant: Accessor<string | undefined>
  variantLabel: (value: string) => string
  onVariantSelect: (value: string) => void
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
  roleSubmitBlocked: Accessor<boolean>
  t: (key: string) => string
  showDialog: (content: () => JSX.Element) => void
}> = (props) => {
  // `aria-activedescendant` target: the currently-highlighted option in the open
  // popover, or undefined when nothing is active / the popover is closed.
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
          <span class="text-icon-base text-12-medium text-[10px]!">{props.t("common.key.esc")}</span>
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
  <div
    ref={props.rootRef}
    classList={{
      "relative size-full flex flex-col gap-0": true,
      "_max-h-[320px]": !props.newSession(),
    }}
    onFocusIn={props.handleRootFocusIn}
  >
    <PromptPopover
      popover={props.popover}
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
    <DockShellForm
      data-component={props.newSession() ? "session-new-composer" : "session-composer"}
      onSubmit={props.handleSubmit}
      classList={{
        "group/prompt-input min-h-[96px] w-full rounded-xl bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]": true,
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
        t={props.t}
      />
      <PromptImageAttachments
        attachments={props.imageAttachments}
        onOpen={(attachment) => props.showDialog(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)}
        onRemove={props.removeAttachment}
        removeLabel={props.t("prompt.attachment.remove")}
      />
      <div
        class="relative min-h-[52px]"
        onMouseDown={(e) => {
          const target = e.target
          if (!(target instanceof HTMLElement)) return
          if (target.closest('[data-action="prompt-attach"], [data-action="prompt-submit"]')) return
          if (props.harnessPending()) return
          props.focusEditor()
        }}
      >
        <div class="relative max-h-[180px] overflow-y-auto no-scrollbar" ref={props.scrollRef}>
          <div
            data-component="prompt-input"
            ref={props.editorRef}
            onFocus={props.onEditorFocus}
            // WAI-ARIA "combobox with list autocomplete": while an @-mention /
            // slash popover is open the editor is a `combobox` controlling the
            // `role="listbox"` in `PromptPopover` (axe requires `aria-expanded`
            // AND `aria-controls` together on `combobox`, so both are present
            // only when open). When closed it stays a plain multi-line
            // `textbox` — `combobox` does not allow `aria-multiline`, and a
            // `combobox` missing `aria-controls` would trip `aria-required-attr`.
            role={props.popover !== null ? "combobox" : "textbox"}
            aria-multiline={props.popover === null ? "true" : undefined}
            aria-expanded={props.popover !== null ? true : undefined}
            aria-controls={props.popover !== null ? PROMPT_POPOVER_LISTBOX_ID : undefined}
            aria-autocomplete={props.popover !== null ? "list" : undefined}
            aria-activedescendant={activeDescendant()}
            aria-label={props.designPlaceholder()}
            aria-disabled={props.harnessPending()}
            contenteditable={props.harnessPending() ? "false" : "true"}
            autocapitalize={props.mode() === "normal" ? "sentences" : "off"}
            autocorrect={props.mode() === "normal" ? "on" : "off"}
            spellcheck={props.mode() === "normal"}
            inputMode="text"
            // @ts-expect-error Solid's JSX types do not include autocomplete on contenteditable nodes.
            autocomplete="off"
            onInput={props.onEditorInput}
            onPaste={props.onEditorPaste}
            onCompositionStart={props.onCompositionStart}
            onCompositionEnd={props.onCompositionEnd}
            onBlur={props.onEditorBlur}
            onKeyDown={props.onEditorKeyDown}
            classList={{
              "select-text": true,
              "min-h-[52px] w-full px-4 pt-4 pb-2 focus:outline-none whitespace-pre-wrap leading-5 text-[13px] font-[440] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)]": true,
              "[&_[data-type=file]]:text-syntax-property": true,
              "[&_[data-type=agent]]:text-syntax-type": true,
              "font-mono!": props.mode() === "shell",
            }}
          />
          <div
            data-component={props.newSession() ? "session-new-design-text" : "session-composer-text"}
            class="absolute top-0 inset-x-0 px-4 pt-4 pointer-events-none whitespace-nowrap truncate leading-5 text-[13px] font-[440] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)]"
            classList={{ "font-mono!": props.mode() === "shell", hidden: props.dirty() }}
          >
            {props.designPlaceholder()}
          </div>
        </div>
      </div>
      <div class="flex h-11 items-center gap-1 px-2">
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
          attachTitle={props.t("prompt.action.attachFile")}
          attachKeybind={props.commandKeybind("file.attach") ?? ""}
          attachStyle={props.attachStyle}
          onAttach={props.pick}
          mode={props.mode}
          harnessPending={props.harnessPending}
          harnessController={props.harnessController}
          harnessDirectory={props.harnessDirectory}
          harnessSessionId={props.harnessSessionId}
          surfaceId={props.surfaceId}
          draftId={props.draftId}
          active={props.active}
          controlStyle={props.controlStyle}
          sessionLocked={props.sessionLocked}
          showAgentSelector={props.showAgentSelector}
          agentTitle={props.t("command.agent.cycle")}
          agentKeybind={props.commandKeybind("agent.cycle") ?? ""}
          agentNames={props.agentNames}
          currentAgentName={props.currentAgentName}
          onAgentSelect={props.onAgentSelect}
          agentTriggerStyle={props.agentTriggerStyle}
          modelHarnessMode={props.modelHarnessMode}
          paidProviderCount={props.paidProviderCount}
          providerLoading={props.providerLoading}
          providerID={props.providerID}
          modelLabel={props.modelLabel}
          model={props.model}
          modelTitle={props.t("command.model.choose")}
          modelKeybind={props.commandKeybind("model.choose") ?? ""}
          onUnpaidModelClick={() => props.showDialog(() => <DialogSelectModelUnpaid />)}
          onModelClose={props.onModelClose}
          showVariantSelector={props.showVariantSelector}
          variantTitle={props.t("command.model.variant.cycle")}
          variantKeybind={props.commandKeybind("model.variant.cycle") ?? ""}
          variants={props.variants}
          currentVariant={props.currentVariant}
          variantLabel={props.variantLabel}
          onVariantSelect={props.onVariantSelect}
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
          readOnlyBlocked={props.roleSubmitBlocked}
          stopLabel={props.t("prompt.action.stop")}
          sendLabel={props.t("prompt.action.send")}
          readOnlyLabel="Read-only workspace"
        />
      </div>
    </DockShellForm>
  </div>
  )
}
