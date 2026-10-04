import type { Accessor, Component, JSX } from "solid-js"
import { PROMPT_POPOVER_LISTBOX_ID, promptAtOptionId, promptSlashOptionId } from "./slash-popover"

export type PromptInputMode = "normal" | "shell"
export type PromptPopoverKind = "at" | "slash" | null

export type PromptEditorSurfaceProps = {
  editorRef: (el: HTMLDivElement) => void
  scrollRef: (el: HTMLDivElement) => void
  newSession: Accessor<boolean>
  mode: Accessor<PromptInputMode>
  dirty: Accessor<boolean>
  readOnly: Accessor<boolean>
  designPlaceholder: Accessor<string>
  focusEditor: VoidFunction
  popover: PromptPopoverKind
  atActive?: string
  slashActive?: string
  onEditorFocus: JSX.EventHandlerUnion<HTMLDivElement, FocusEvent>
  onEditorInput: JSX.EventHandlerUnion<HTMLDivElement, InputEvent>
  onEditorPaste: JSX.EventHandlerUnion<HTMLDivElement, ClipboardEvent>
  onCompositionStart: JSX.EventHandlerUnion<HTMLDivElement, CompositionEvent>
  onCompositionEnd: JSX.EventHandlerUnion<HTMLDivElement, CompositionEvent>
  onEditorBlur: JSX.EventHandlerUnion<HTMLDivElement, FocusEvent>
  onEditorKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
}

export const PromptEditorSurface: Component<PromptEditorSurfaceProps> = (props) => {
  const activeDescendant = () => {
    if (props.popover === "at" && props.atActive) return promptAtOptionId(props.atActive)
    if (props.popover === "slash" && props.slashActive) return promptSlashOptionId(props.slashActive)
    return undefined
  }

  return (
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
          contenteditable={props.readOnly() ? "false" : "true"}
          aria-readonly={props.readOnly() || undefined}
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
  )
}
