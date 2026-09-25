import { Show, type Accessor, type Component, type JSX } from "solid-js"
import type { ComposerTextKey } from "../i18n"
import { DockShellForm } from "@/ui"
import { PromptDragOverlay } from "./drag-overlay"
import { PromptPopover, type AtOption, type SlashCommand } from "./slash-popover"
import {
  ComposerNoticeProvider,
  ComposerNoticeRow,
  createComposerNoticeChannel,
  useComposerNoticeChannel,
} from "./composer-notice"
import { PromptContextStrip, type PromptContextStripProps } from "./context-strip"
import { PromptEditorSurface, type PromptEditorSurfaceProps, type PromptPopoverKind } from "./editor-surface"
import { PromptToolbar, type PromptToolbarProps } from "./toolbar"

type PromptDraggingType = "image" | "@mention" | null

export type PromptPopoverBindings = {
  popover: PromptPopoverKind
  documentPicker: boolean
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
}

export type PromptInputFrameProps = PromptPopoverBindings &
  PromptEditorSurfaceProps &
  PromptContextStripProps &
  PromptToolbarProps & {
    rootRef: (el: HTMLDivElement) => void
    className?: string
    newSession: Accessor<boolean>
    collapsed: Accessor<boolean>
    draggingType: Accessor<PromptDraggingType>
    documentNotice?: string
    handleRootFocusIn: VoidFunction
    handleSubmit: JSX.EventHandlerUnion<HTMLFormElement, SubmitEvent>
    t: (key: ComposerTextKey) => string
  }

export const PromptInputFrame: Component<PromptInputFrameProps> = (props) => {
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
      <PromptContextStrip {...props} />
      <PromptEditorSurface {...props} />
      <PromptToolbar {...props} />
    </DockShellForm>
  </div>
  </ComposerNoticeProvider>
  )
}
