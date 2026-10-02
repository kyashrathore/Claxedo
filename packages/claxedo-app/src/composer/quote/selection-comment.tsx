import { createEffect, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { quoteContextItem, type QuoteSource } from "../model"
import { useComposerStore, type ComposerKey } from "../store"
import { QuoteBox } from "./quote-box"
import { createQuoteSelection } from "./quote-selection"
import { quoteSurfaceKey, useQuoteSurfaces } from "./surfaces"

export function SelectionComment(props: {
  readonly root: Accessor<HTMLElement | undefined>
  readonly composerKey: Accessor<ComposerKey | undefined>
  readonly source: QuoteSource
}): JSX.Element {
  const store = useComposerStore()
  const surfaces = useQuoteSurfaces()
  const selection = createQuoteSelection({ root: props.root, enabled: () => props.composerKey() !== undefined })
  createEffect(() => {
    const root = props.root()
    const key = props.composerKey()
    if (root && key) onCleanup(surfaces.register(quoteSurfaceKey(key, props.source), root))
  })
  const submit = (comment: string) => {
    const key = props.composerKey()
    const quote = selection.current()?.quote
    if (!key || !quote) return
    store.addContext(key, quoteContextItem({ source: props.source, quote, comment }))
    document.getSelection()?.removeAllRanges()
    selection.close()
  }
  return (
    <Show when={selection.position()}>
      {(position) => (
        <QuoteBox
          position={position()}
          ref={selection.setBox}
          value={selection.draft()}
          autofocus={false}
          onInput={selection.setDraft}
          onCancel={selection.close}
          onSubmit={submit}
        />
      )}
    </Show>
  )
}
