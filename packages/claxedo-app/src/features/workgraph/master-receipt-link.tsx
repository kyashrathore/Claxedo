import { Show } from "solid-js"

export function MasterReceiptLink(props: {
  reference: string
  label: string
  onOpen?: (invoker: HTMLButtonElement) => void
}) {
  const href = () => safeExternalHref(props.reference)
  return (
    <Show
      when={href()}
      fallback={
        <Show when={props.onOpen} fallback={<code title={props.reference}>{props.label}</code>}>
          {(open) => (
            <button
              type="button"
              class="workgraph-master-receipt-link"
              title={props.reference}
              aria-label={`Open master receipt ${props.reference}`}
              onClick={(event) => {
                event.stopPropagation()
                open()(event.currentTarget)
              }}
            >
              {props.label}
            </button>
          )}
        </Show>
      }
    >
      {(external) => (
        <a
          class="workgraph-master-receipt-link"
          href={external()}
          target="_blank"
          rel="noreferrer"
          title={props.reference}
          aria-label={`Open master receipt ${props.reference}`}
          onClick={(event) => event.stopPropagation()}
        >
          {props.label}
        </a>
      )}
    </Show>
  )
}

function safeExternalHref(reference: string) {
  try {
    const url = new URL(reference)
    if (url.protocol !== "https:" && url.protocol !== "http:") return
    return url.href
  } catch {
    return
  }
}
