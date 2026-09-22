export type UiErrorReporter = (error: unknown, context: { source: string }) => void

let reporter: UiErrorReporter | undefined

/**
 * The app owns error tracking; this package cannot depend on it. The app
 * installs its reporter once at boot, and until then (storybook, tests, the
 * session app) a reported error is dropped rather than written to the console.
 */
export function setUiErrorReporter(next: UiErrorReporter | undefined) {
  reporter = next
}

/** A failure this package handled itself and would otherwise have swallowed. */
export function reportUiError(error: unknown, source: string) {
  reporter?.(error, { source })
}
