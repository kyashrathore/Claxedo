export function DocumentRecoveryState(props: {
  kind: "missing" | "archived" | "rejected" | "error"
  message: string
  onBack?: () => void
  onRetry?: () => void
}) {
  return (
    <main class="flex size-full items-start justify-center bg-background-base px-6 py-16">
      <section class="w-full max-w-lg" role="alert">
        <p class="text-xs font-medium uppercase tracking-wide text-text-weak">Document unavailable</p>
        <h1 class="mt-2 text-lg font-medium text-text-strong">
          {props.kind === "archived"
            ? "This document is archived"
            : props.kind === "missing"
              ? "Document not found"
              : "Document could not be opened"}
        </h1>
        <p class="mt-2 text-sm leading-6 text-text-weak">{props.message}</p>
        <div class="mt-5 flex gap-2">
          {props.onRetry && (
            <button
              type="button"
              class="rounded bg-surface-raised-base px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2"
              onClick={props.onRetry}
            >
              Try again
            </button>
          )}
          {props.onBack && (
            <button
              type="button"
              class="rounded px-3 py-1.5 text-sm hover:bg-surface-raised-base focus-visible:outline focus-visible:outline-2"
              onClick={props.onBack}
            >
              Back to Documents
            </button>
          )}
        </div>
      </section>
    </main>
  )
}
