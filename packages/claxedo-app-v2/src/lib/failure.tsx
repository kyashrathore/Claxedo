import { ErrorBoundary, type JSX } from "solid-js"
import "./failure.css"

export function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return String(error)
}

export function FailureNotice(props: {
  readonly title: string
  readonly message: string
  readonly retryLabel: string
  readonly onRetry: () => void
}): JSX.Element {
  return (
    <div class="failure-notice" role="alert">
      <p class="failure-notice-title">{props.title}</p>
      <p class="failure-notice-message">{props.message}</p>
      <button type="button" class="failure-notice-retry" onClick={() => props.onRetry()}>
        {props.retryLabel}
      </button>
    </div>
  )
}

export function FailureBoundary(props: {
  readonly title: string
  readonly retryLabel: string
  readonly onError?: (error: unknown) => void
  readonly children: JSX.Element
}): JSX.Element {
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        props.onError?.(error)
        return <FailureNotice title={props.title} message={failureMessage(error)} retryLabel={props.retryLabel} onRetry={reset} />
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}
