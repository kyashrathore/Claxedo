import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useCommands } from "@/shell"
import { useDialog } from "@/ui"
import type { FileContextItem, ImagePart } from "../model"
import { promptText } from "../model"
import { createComposer, type ComposerProps } from "../setup"
import { acceptedFileTypes } from "../attachments/files"
import { firstMarkNumber, numberImageMarks, type NumberedImageMark } from "../marks/marks"
import { ImageMarkEditor } from "../marks/editor"
import { renderPromptEditor } from "../editor/serialization"
import { promptDesignPlaceholder } from "../role-gate"
import type { AtItem } from "../suggestions"
import { PROMPT_EXAMPLES } from "./examples"
import { PromptInputFrame } from "./frame"
import { promptPlaceholder } from "./placeholder"
import { promptAtOptionKey } from "./prompt-options"
import type { AtOption } from "./slash-popover"
import { createPromptToolbarMotion } from "./toolbar-motion"
import { createComposerToasts, ReadingNotices } from "./notice"
import { SessionHealthPeek } from "./health-peek"
import { commentFocus } from "./comment-routing"
import { usePanel } from "@/panel"

function atOption(item: AtItem): AtOption {
  if (item.kind === "file") return { type: "file", path: item.path, display: item.path }
  return { type: "document", documentId: item.id, display: item.entry.label, originKind: "managed", placementKind: "local", status: item.entry.group }
}

function createAtOptions(items: () => readonly AtItem[]) {
  const pairs = createMemo(() => items().map((item) => ({ item, option: atOption(item) })))
  return {
    flat: createMemo(() => pairs().map((pair) => pair.option)),
    itemOf: (key: string) => pairs().find((pair) => promptAtOptionKey(pair.option) === key)?.item,
    keyOf: (id: string | undefined) => {
      const pair = pairs().find((candidate) => candidate.item.id === id)
      return pair ? promptAtOptionKey(pair.option) : undefined
    },
  }
}

export function Composer(props: ComposerProps) {
  const composer = createComposer(props)
  const dialog = useDialog()
  const commands = useCommands()
  const t = composer.t
  const controller = composer.controller
  const mode = () => controller.state.mode
  const popover = () => (controller.state.popover.kind === "closed" ? null : controller.state.popover.kind)
  const motion = createPromptToolbarMotion({ shellMode: () => mode() === "shell", pending: composer.harnessPending })
  const [placeholderIndex] = createSignal(Math.floor(Math.random() * PROMPT_EXAMPLES.length))
  const at = createAtOptions(composer.suggestions.atItems)
  const panel = usePanel()
  const [activeComment, setActiveComment] = createSignal<string>()
  createComposerToasts(composer)
  let slashPopover: HTMLDivElement | undefined

  const fileItems = createMemo(() => composer.draft().context.filter((item): item is FileContextItem => item.type === "file"))
  const commentCount = createMemo(() => (mode() === "shell" ? 0 : fileItems().filter((item) => !!item.comment?.trim()).length))
  const contextItems = createMemo(() => (mode() === "shell" ? fileItems().filter((item) => !item.comment?.trim()) : fileItems()))
  const dirty = createMemo(() => promptText(composer.draft().prompt).length > 0 || composer.draft().prompt.some((part) => part.type !== "text"))
  const suggest = createMemo(() => !props.view?.messages().some((message) => message.role === "user"))
  const placeholder = () =>
    promptPlaceholder({
      mode: mode(),
      commentCount: commentCount(),
      example: suggest() ? t(PROMPT_EXAMPLES[placeholderIndex()]) : "",
      suggest: suggest(),
      t,
    })
  const designPlaceholder = () =>
    composer.draft().goalArmed
      ? t("prompt.goal.placeholder")
      : promptDesignPlaceholder({ authorityBlock: props.readOnly ? "workspace-role" : undefined, mode: mode(), shellPlaceholder: placeholder() })

  createEffect(() => {
    if (popover() !== "slash") return
    const active = controller.state.activeId
    if (!active || !slashPopover) return
    requestAnimationFrame(() => slashPopover?.querySelector(`[data-slash-id="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }))
  })

  const openMarks = (image: ImagePart, focusIndex?: number) => {
    dialog.show(() => (
      <ImageMarkEditor
        image={image}
        firstNumber={firstMarkNumber(composer.images(), image.id)}
        focusIndex={focusIndex}
        onSave={(marks) => composer.store.setImageMarks(composer.key(), image.id, marks)}
      />
    ))
  }
  const removeImageMark = (entry: NumberedImageMark) => {
    const image = composer.images().find((part) => part.id === entry.imageId)
    if (image) composer.store.setImageMarks(composer.key(), image.id, (image.marks ?? []).filter((_, index) => index !== entry.index))
  }

  return (
    <>
    <Show when={props.view}>
      <SessionHealthPeek composer={composer} />
    </Show>
    <ReadingNotices composer={composer} />
    <PromptInputFrame
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
      popover={popover()}
      documentPicker={false}
      setSlashPopoverRef={(element) => {
        slashPopover = element
      }}
      atFlat={at.flat()}
      atActive={popover() === "at" ? at.keyOf(controller.state.activeId) : undefined}
      atKey={promptAtOptionKey}
      setAtActive={(key) => {
        const item = at.itemOf(key)
        if (item) controller.setActive(item.id)
      }}
      onAtSelect={(option) => {
        const item = at.itemOf(promptAtOptionKey(option))
        if (item) controller.selectAt(item)
      }}
      slashFlat={composer.suggestions.slashItems()}
      slashActive={popover() === "slash" ? controller.state.activeId : undefined}
      setSlashActive={controller.setActive}
      onSlashSelect={controller.selectSlash}
      commandKeybind={(id) => commands.keybind(id) || undefined}
      contextItems={contextItems()}
      contextActive={(item) => !!item.commentId && item.commentId === activeComment()}
      openComment={(item) => {
        const focus = commentFocus(item)
        if (!focus) return
        setActiveComment(item.commentId)
        panel.show(focus)
      }}
      removeContextItem={(item) => composer.store.removeContext(composer.key(), item.key)}
      imageAttachments={composer.images()}
      imageMarks={numberImageMarks(composer.images())}
      openImageMarks={openMarks}
      removeImageMark={removeImageMark}
      removeAttachment={(id) => composer.store.removeImage(composer.key(), id)}
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
      statusStage={() => undefined}
      stoppable={composer.working}
      abort={() => void composer.send.stop()}
      onRetry={() => undefined}
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
