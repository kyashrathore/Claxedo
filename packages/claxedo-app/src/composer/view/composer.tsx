import { createMemo, Show } from "solid-js"
import { useCommands } from "@/shell"
import { useDialog } from "@/ui"
import type { FileContextItem } from "../model"
import { promptText } from "../model"
import { createComposer, type ComposerProps } from "../setup"
import { acceptedFileTypes } from "../attachments/files"
import { renderPromptEditor } from "../editor/serialization"
import { PromptInputFrame } from "./frame"
import { createPromptToolbarMotion } from "./toolbar-motion"
import { createComposerToasts, ReadingNotices } from "./notice"
import { SessionHealthPeek } from "./health-peek"
import { createEditorPlaceholder } from "./editor-placeholder"
import { createPromptPopoverBindings } from "./popover-bindings"
import { createPromptContextBindings } from "./context-bindings"
import { createPromptImageMarkBindings } from "./image-mark-bindings"
import { usePanel } from "@/panel"

export function Composer(props: ComposerProps) {
  const composer = createComposer(props)
  const dialog = useDialog()
  const commands = useCommands()
  const t = composer.t
  const controller = composer.controller
  const mode = () => controller.state.mode
  const popover = () => (controller.state.popover.kind === "closed" ? null : controller.state.popover.kind)
  const motion = createPromptToolbarMotion({ shellMode: () => mode() === "shell", pending: composer.harnessPending })
  const panel = usePanel()
  createComposerToasts(composer)

  const fileItems = createMemo(() => composer.draft().context.filter((item): item is FileContextItem => item.type === "file"))
  const dirty = createMemo(() => promptText(composer.draft().prompt).length > 0 || composer.draft().prompt.some((part) => part.type !== "text"))
  const designPlaceholder = createEditorPlaceholder({ composer, mode, fileItems, view: () => props.view, readOnly: () => props.readOnly })
  const popoverBindings = createPromptPopoverBindings({ composer, popover, keybind: commands.keybind })
  const contextBindings = createPromptContextBindings({ composer, mode, fileItems, panel })
  const imageMarkBindings = createPromptImageMarkBindings({ composer, dialog })

  return (
    <>
    <Show when={props.view}>
      <SessionHealthPeek composer={composer} />
    </Show>
    <ReadingNotices composer={composer} />
    <PromptInputFrame
      {...popoverBindings}
      {...contextBindings}
      {...imageMarkBindings}
      rootRef={composer.refs.setRoot}
      editorRef={(element) => {
        composer.refs.setEditor(element)
        renderPromptEditor(element, composer.draft().prompt)
      }}
      scrollRef={composer.refs.setScroll}
      newSession={() => !props.view}
      mode={mode}
      dirty={dirty}
      collapsed={() => !!props.collapsible && !controller.state.focused && !dirty() && composer.draft().context.length === 0 && popover() === null}
      draggingType={() => (composer.dragging() === "files" ? "image" : composer.dragging() === "mention" ? "@mention" : null)}
      designPlaceholder={designPlaceholder}
      handleRootFocusIn={() => undefined}
      handleSubmit={(event) => {
        event.preventDefault()
        if (composer.working() && controller.blank()) void composer.send.stop()
        else void composer.send.send()
      }}
      harnessPending={composer.harnessPending}
      onEditorFocus={() => controller.setFocused(true)}
      onEditorInput={() => controller.onInput()}
      onEditorPaste={(event) => void composer.reader.handlePaste(event)}
      onCompositionStart={() => controller.setComposing(true)}
      onCompositionEnd={() => controller.setComposing(false)}
      onEditorBlur={() => controller.setFocused(false)}
      onEditorKeyDown={(event) => {
        if (event.key === "Escape" && props.queuedEdit?.active() && popover() === null && mode() === "normal") {
          event.preventDefault()
          event.stopPropagation()
          props.queuedEdit.cancel()
          return
        }
        controller.onKeyDown(event)
      }}
      focusEditor={() => controller.focusEditor()}
      fileInputRef={composer.refs.setFileInput}
      acceptedFileTypes={acceptedFileTypes}
      addAttachments={(files) => void composer.reader.addFiles(files)}
      attachStyle={motion.buttons}
      pick={() => composer.refs.fileInput()?.click()}
      openCommands={() => controller.openCommands()}
      openContext={() => controller.openContext()}
      enterShellMode={() => controller.setMode("shell")}
      goalSelectable={composer.goalAvailable}
      goalArmed={() => composer.draft().goalArmed}
      armGoal={() => composer.send.armGoal()}
      toggleGoal={() => {
        composer.send.disarmGoal()
        controller.focusEditor()
      }}
      approveEnabled={() => props.readOnly !== true}
      permissionGroups={composer.permissionMode.groups}
      permissionCurrent={composer.permissionMode.current}
      onPermissionSelect={composer.permissionMode.select}
      onPermissionOpen={composer.permissionMode.openModes}
      harnessController={() => composer.harnessController}
      harnessScope={composer.key}
      harnessScopeInput={composer.harnessScopeInput}
      active={() => true}
      controlStyle={motion.control}
      sessionLocked={() => props.view !== undefined}
      showAgentSelector={() => false}
      agentNames={() => []}
      currentAgentName={() => ""}
      onAgentSelect={() => undefined}
      stoppable={composer.working}
      booting={composer.booting}
      working={composer.working}
      blank={controller.blank}
      bootText={composer.bootText}
      submitDisabled={() => composer.send.sending() || (!composer.working() && !!composer.submitBlock() && !composer.submitBlock()?.actionable)}
      submitExcludeFromTab={() => false}
      submitBlock={composer.submitBlock}
      onChooseModel={() => composer.refs.root()?.querySelector<HTMLElement>('[data-action="prompt-harness-model"]')?.click()}
      workspaceRoleBlocked={() => props.readOnly === true}
      t={t}
    />
    </>
  )
}
