import { Show } from "solid-js"
import type { ComposerSetup } from "../setup"
import { renderPromptEditor } from "../editor/serialization"

export const COMPOSER_LISTBOX_ID = "composer-popover"
export const composerOptionId = (id: string) => `composer-option-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`

export function ComposerEditor(props: { composer: ComposerSetup; placeholder: string }) {
  const composer = () => props.composer
  const controller = () => composer().controller
  const state = () => controller().state
  const popover = () => state().popover.kind !== "closed"

  return (
    <div
      data-slot="composer-editor"
      onMouseDown={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest("button, [role=option]")) return
        if (event.target !== event.currentTarget) return
        controller().focusEditor()
      }}
    >
      <div ref={composer().refs.setScroll} data-slot="composer-scroll">
        <div
          ref={(element) => {
            composer().refs.setEditor(element)
            renderPromptEditor(element, composer().draft().prompt)
          }}
          data-slot="composer-input"
          data-mode={state().mode}
          role={popover() ? "combobox" : "textbox"}
          aria-multiline={popover() ? undefined : "true"}
          aria-expanded={popover() ? true : undefined}
          aria-controls={popover() ? COMPOSER_LISTBOX_ID : undefined}
          aria-autocomplete={popover() ? "list" : undefined}
          aria-activedescendant={popover() && state().activeId ? composerOptionId(state().activeId ?? "") : undefined}
          aria-label={composer().t("composer.editor.label")}
          contenteditable={!composer().disabled()}
          autocapitalize={state().mode === "normal" ? "sentences" : "off"}
          autocorrect={state().mode === "normal" ? "on" : "off"}
          spellcheck={state().mode === "normal"}
          inputMode="text"
          onInput={() => controller().onInput()}
          onKeyDown={(event) => controller().onKeyDown(event)}
          onKeyUp={() => controller().onCursor()}
          onPointerUp={() => controller().onCursor()}
          onPaste={(event) => void composer().reader.handlePaste(event)}
          onCompositionStart={() => controller().setComposing(true)}
          onCompositionEnd={() => controller().setComposing(false)}
          onFocus={() => controller().setFocused(true)}
          onBlur={() => controller().setFocused(false)}
        />
        <Show when={!controller().text()}>
          <div data-slot="composer-placeholder" data-mode={state().mode}>
            {props.placeholder}
          </div>
        </Show>
      </div>
    </div>
  )
}
