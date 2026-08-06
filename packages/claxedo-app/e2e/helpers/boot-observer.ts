/**
 * BOOT OBSERVER — catches boot-time failures that sampled screenshots miss.
 *
 * WHY THIS EXISTS: the "Failed to load sessions for {project}" toast
 * (packages/claxedo-app/src/app/boot/data/bootstrap-orchestrator.ts:356-364) fires
 * during boot off a rejected `queryClient.fetchQuery` and is rendered by whatever
 * toast component `showToast` mounts — which auto-dismisses on its own timer. A
 * spec that takes a screenshot on a `setTimeout`/`page.waitForTimeout` sample, or
 * even one that asserts on final DOM state, can watch the toast appear and vanish
 * between samples and see nothing. That exact mistake was made twice in one day
 * chasing this bug before this file existed. The only reliable way to catch a
 * transient DOM node is to observe continuously from before the first paint.
 *
 * MECHANISM: `page.addInitScript` runs in the page's own JS context BEFORE any of
 * the app's bundled scripts execute (Playwright guarantees init scripts run prior
 * to the document's inline/module scripts on every navigation). That ordering is
 * load-bearing here: `window.fetch` must be monkey-patched before the app's own
 * bootstrap code captures a reference to it, and the MutationObserver must be
 * attached before `document.body` receives its first mutation, or the very first
 * boot-time toast/request racing the page load would be missed.
 *
 * Everything the app does is recorded into `window.__BOOT_OBSERVER__`, which
 * survives even if the DOM node that logged it is later removed — reads happen out
 * of band via `readBootObserver`, never by inspecting live DOM state.
 */
import type { BrowserContext, Page } from "@playwright/test"

export interface BootObserverFetchFailure {
  url: string
  method: string
  status: number
}

export interface BootObserverNetworkError {
  url: string
  method: string
  message: string
}

export interface BootObserverToast {
  text: string
  tagName: string
  timestamp: number
}

export interface BootObserverState {
  toasts: BootObserverToast[]
  failures: BootObserverFetchFailure[]
  networkErrors: BootObserverNetworkError[]
}

declare global {
  interface Window {
    __BOOT_OBSERVER__?: BootObserverState
  }
}

/**
 * Installs the observer via `addInitScript` so it is live for every subsequent
 * navigation on the target (Playwright re-runs init scripts on each new
 * document). Call this BEFORE the target's first navigation — calling it after
 * navigation already started is exactly the "sampled screenshot" mistake this
 * file exists to prevent, just moved into the harness instead of the assertion.
 *
 * ACCEPTS `Page | BrowserContext` — added 2026-08-06 for the packaged-Electron
 * lane (`desktop-unsigned-embedded.spec.ts`). A `Page`-only signature cannot be
 * wired into that harness at all: `electron-app.ts`'s `launchPackagedApp` only
 * hands back a `Page` from `waitForShellWindow()`, which by construction
 * resolves AFTER `index.html` has already loaded — so a
 * `page.addInitScript(...)` call made on that returned page can never run
 * before the app's own bootstrap scripts, and would silently observe nothing
 * from real boot. `BrowserContext.addInitScript` has the identical effect but
 * applies to every window opened in that context from then on (splash AND
 * shell alike), and Electron's `BrowserContext` exists the instant
 * `electron.launch()` resolves — before either window is created. VERIFIED
 * live 2026-08-06 against the packaged app: a context-level install captured
 * the shell window's real `fetch` calls and toast mutations from its very
 * first paint (confirmed by deliberately reproducing the `data_dir_already_owned`
 * 409 → "Failed to load sessions" toast pair and seeing both the non-2xx
 * response and the toast text land in `window.__BOOT_OBSERVER__` on the
 * eventual shell page) — see `electron-app.ts`'s `beforeShellWindow` hook,
 * which is the only call site that needs the `BrowserContext` branch.
 */
export async function installBootObserver(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    const state: {
      toasts: Array<{ text: string; tagName: string; timestamp: number }>
      failures: Array<{ url: string; method: string; status: number }>
      networkErrors: Array<{ url: string; method: string; message: string }>
    } = { toasts: [], failures: [], networkErrors: [] }
    window.__BOOT_OBSERVER__ = state

    // --- fetch patch -------------------------------------------------------
    // Patched here, before the app's own module graph evaluates, so every fetch
    // the app ever issues — including the very first boot request — goes through
    // this wrapper. A patch installed from a spec's `page.evaluate` after
    // navigation would be too late: by then the app has already called the
    // original `fetch` and captured no reference to this one.
    const originalFetch = window.fetch.bind(window)
    const patchedFetch = async (...args: Parameters<typeof fetch>) => {
      const request = args[0]
      const init = args[1]
      const url = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url
      const method = (init?.method ?? (typeof request === "object" && "method" in request ? request.method : undefined) ?? "GET").toUpperCase()
      try {
        const response = await originalFetch(...args)
        if (!response.ok) {
          state.failures.push({ url, method, status: response.status })
        }
        return response
      } catch (err) {
        // Thrown fetches (network down, CORS, DNS, connection refused) never
        // produce a Response at all, so they cannot be caught by the `!response.ok`
        // branch above — record them separately so a total network failure is
        // just as visible as an HTTP error status.
        state.networkErrors.push({ url, method, message: err instanceof Error ? err.message : String(err) })
        throw err
      }
    }
    // `typeof fetch` in current lib.dom.d.ts requires a `preconnect` static
    // method on the function value (a real browser API surface), which our
    // plain patch function doesn't have — copy it over from the original so
    // the assignment below type-checks without an `any`/`@ts-expect-error`
    // escape hatch, and so anything that calls `fetch.preconnect(...)` still
    // works against the real browser implementation.
    window.fetch = Object.assign(patchedFetch, { preconnect: originalFetch.preconnect })

    // --- toast/error-text observer -----------------------------------------
    // Recorded at mutation time, not read back from the DOM later: toast
    // components in this app auto-dismiss on a timer, so by the time any
    // post-hoc DOM query runs the node is already gone. Capturing full
    // `textContent` at the moment of insertion is the only way to keep the
    // literal message text.
    const pattern = /failed|error|unable|could not/i
    const seen = new Set<string>()
    const recordIfMatch = (el: Element) => {
      const text = (el.textContent ?? "").trim()
      if (!text || !pattern.test(text)) return
      // Dedupe on (tagName + text): a single toast mount can trigger multiple
      // mutation records (e.g. one per child text node), and without this the
      // same literal toast would be logged many times over its lifetime.
      const key = `${el.tagName}:${text}`
      if (seen.has(key)) return
      seen.add(key)
      state.toasts.push({ text, tagName: el.tagName, timestamp: Date.now() })
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          // Fine-grained reactive frameworks (this app is Solid.js) frequently
          // update text by swapping a bare `Text` node into an already-mounted
          // element's children (remove old Text node, insert new Text node) —
          // NOT by setting `.data` on an existing node (that would be a
          // `characterData` mutation, handled below) and NOT by mounting a new
          // wrapper `Element` (handled by `recordIfMatch(node)` a few lines
          // down). An earlier version of this observer only checked
          // `node instanceof Element` here, so a toast whose title/description
          // renders as a direct Text-node child of an already-existing wrapper
          // would be silently invisible to this observer. This is defensive
          // hardening based on Solid's general update strategy, NOT something
          // directly confirmed against the "Failed to load sessions" toast
          // specifically — in the live repro run (see spec used to chase this
          // bug) the toast never rendered at all even with this fix in place
          // (see investigation notes), so this branch is unverified for that
          // exact toast and should be re-checked if this file is used to chase
          // a similar transient-toast bug again. Route bare Text-node
          // insertions through the parent element's full text, same as the
          // characterData branch below.
          if (node instanceof Text) {
            if (node.parentElement) recordIfMatch(node.parentElement)
            return
          }
          if (!(node instanceof Element)) return
          recordIfMatch(node)
          // The matching text is very often on a descendant (an inner <p> or
          // <span> inside a toast wrapper `<div>`), not the added node itself —
          // walk descendants too or most real toasts would be missed.
          node.querySelectorAll("*").forEach((child) => recordIfMatch(child))
        })
        // Text-only mutations (e.g. a toast whose message is set after the
        // wrapper element mounts) surface as characterData changes on a text
        // node; check the parent element's full text in that case too.
        if (mutation.type === "characterData" && mutation.target.parentElement) {
          recordIfMatch(mutation.target.parentElement)
        }
      }
    })

    // `document.body` may not exist yet this early (init scripts can run before
    // `<body>` is parsed) — observing `documentElement` and enabling
    // `subtree: true` guarantees body's future insertion and everything under it
    // is still covered.
    const attach = () => {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }
    if (document.documentElement) attach()
    else document.addEventListener("DOMContentLoaded", attach, { once: true })
  })
}

/** Reads the observer's accumulated state out of the page's live JS context. */
export async function readBootObserver(page: Page): Promise<BootObserverState> {
  return page.evaluate(() => window.__BOOT_OBSERVER__ ?? { toasts: [], failures: [], networkErrors: [] })
}

/**
 * PERMANENT ASSERTION — asserts boot produced no error toast and no non-2xx
 * server response. Intentionally NOT wired into any existing spec here (other
 * agents own those files); the caller decides where in their boot flow to invoke
 * it, after `installBootObserver` + navigation + whatever wait the spec already
 * does for boot to settle.
 *
 * Kept as a hand-rolled assertion (not `expect(...).toBe(...)`) so the failure
 * message can enumerate every observed toast/failure/network-error, not just
 * report a count mismatch — the whole point of this file is that these events
 * are otherwise invisible, so the assertion failure needs to BE the evidence.
 */
export async function expectNoBootErrors(page: Page): Promise<void> {
  const state = await readBootObserver(page)
  const problems: string[] = []
  if (state.toasts.length > 0) {
    problems.push(
      `${state.toasts.length} error-shaped toast(s) appeared during boot:\n` +
        state.toasts.map((t) => `  - [${t.tagName}] "${t.text}"`).join("\n"),
    )
  }
  if (state.failures.length > 0) {
    problems.push(
      `${state.failures.length} non-2xx response(s) during boot:\n` +
        state.failures.map((f) => `  - ${f.method} ${f.url} -> ${f.status}`).join("\n"),
    )
  }
  if (state.networkErrors.length > 0) {
    problems.push(
      `${state.networkErrors.length} network-level fetch failure(s) during boot:\n` +
        state.networkErrors.map((e) => `  - ${e.method} ${e.url} -> ${e.message}`).join("\n"),
    )
  }
  if (problems.length > 0) {
    throw new Error(`expectNoBootErrors: boot was not clean.\n\n${problems.join("\n\n")}`)
  }
}
