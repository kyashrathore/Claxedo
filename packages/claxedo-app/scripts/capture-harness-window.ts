/**
 * The browser-side globals every `capture-*.ts` motion harness installs with
 * `page.addInitScript` and reads back with `page.evaluate`.
 *
 * Declared once, here, instead of being re-asserted at each use site: a harness
 * used to reach the page as `window as unknown as Record<string, unknown>` on
 * the way in and as a differently-shaped `window as unknown as { … }` on the
 * way out, so nothing checked that the two halves described the same object.
 *
 * `AuthDisplayUser` is the type the app itself reads back out of
 * `__CLAXEDO_TEST_AUTH_USER__` (`src/platform/auth/browser-auth-test-bypass.ts`),
 * so a harness can no longer seed a shape the app cannot consume.
 *
 * Harness-specific globals stay in the harness that installs them, as a local
 * `declare global` block; only the four below are shared.
 *
 * A harness picks this up by importing a type from here, or — when it needs no
 * type — with a bare `import "./capture-harness-window"`.
 */
import type { AuthDisplayUser } from "../src/platform/auth/auth-display"

/** One `window.fetch` call, recorded by a harness init script. */
export type FetchLogEntry = {
  url: string
  atMs: number
  /**
   * Only recorded by harnesses hunting a specific offending request, so that
   * the report can name the caller rather than just the URL.
   */
  stack?: string
}

/** One `claxedo:review-vcs-load` event, recorded by a harness init script. */
export type ReviewLoadLogEntry = {
  atMs: number
  detail: unknown
}

declare global {
  interface Window {
    __CLAXEDO_TEST_AUTH_TOKEN__?: string
    __CLAXEDO_TEST_AUTH_USER__?: AuthDisplayUser
    __CLAXEDO_FETCH_LOG__?: FetchLogEntry[]
    __CLAXEDO_REVIEW_LOAD_LOG__?: ReviewLoadLogEntry[]
  }
}
