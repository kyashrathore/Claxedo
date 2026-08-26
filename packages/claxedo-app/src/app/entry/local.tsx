/**
 * The local product's entry point.
 *
 * `main.tsx` is the hosted one. The difference between them is not a flag: this
 * file exists so that the LOCAL bundle's import graph never reaches an identity
 * provider, a cloud runtime store, or an authenticated transport. A shared
 * entry with `if (authEnabled)` would still ship all of it, which is the whole
 * problem the split addresses — the code is in the bundle whether or not the
 * branch runs.
 *
 * Concretely, what this entry does NOT import, and why each matters:
 *
 *   - `@/platform/auth/auth-client` — Clerk. The largest single dependency in
 *     the hosted bundle, and an unsigned desktop can never use it.
 *   - `@/platform/api/api`'s `authFetch` — attaches a bearer. There is no
 *     bearer here; the local server authenticates by loopback.
 *   - the analytics identity path — `identityProps()` reads an account.
 *
 * `local-entry-closure.test.ts` asserts those absences against the real import
 * graph rather than trusting this comment.
 *
 * What replaces them: a plain `fetch` to the loopback server, and a platform
 * descriptor that reports `version: "local"` so downstream code that already
 * branches on it keeps working.
 */

// @refresh reload
import { render } from "@solidjs/web"
import { AppBaseProviders, AppInterface } from "@/app/entry/app"
import { PlatformProvider, type Platform } from "@claxedo/app"
import { initClaxedo, getDefaultConfig } from "./index"
import { urlRoutingEnabled } from "@/lib/runtime-mode"
import { ConfigProvider } from "../providers/config"

const config = { ...getDefaultConfig(), authEnabled: false }
initClaxedo(config)

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error("Root element not found. Make sure there is an element with id='root' in index.local.html")
}

/**
 * The local platform descriptor.
 *
 * `fetch` is the global one, unwrapped. The hosted entry passes `authFetch`,
 * which attaches a bearer from the identity provider; there is nothing to
 * attach here, and importing that helper would pull the provider in with it.
 *
 * `getAuthToken` is deliberately absent rather than a stub returning null. A
 * stub would let a hosted surface compile against this platform and fail at
 * runtime; the absence makes it a type error, which is where that mistake
 * belongs.
 */
const platform: Platform = {
  platform: "web",
  version: "local",
  fetch: (input, init) => fetch(input, init),
  openLink(url: string) {
    window.open(url, "_blank")
  },
  restart: async () => {
    window.location.reload()
  },
  back() {
    window.history.back()
  },
  forward() {
    window.history.forward()
  },
  notify: async (title, description, href) => {
    if (!("Notification" in window)) return
    // Never request permission here — completing a turn must not trigger the
    // browser's prompt. Permission is only requested from an explicit Settings
    // interaction.
    if (Notification.permission !== "granted") return
    if (document.visibilityState === "visible" && document.hasFocus()) return

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, { body: description ?? "", icon: "/favicon-96x96-v3.png" })
        notification.onclick = () => {
          window.focus()
          if (href && urlRoutingEnabled()) {
            window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
          notification.close()
        }
      })
      .catch(() => undefined)
  },
}

function startApp() {
  if (import.meta.env.DEV) console.log("[claxedo:boot]", "local", window.location.href)
  render(
    () => (
      <PlatformProvider value={platform}>
        <ConfigProvider config={config}>
          <AppBaseProviders>
            <AppInterface />
          </AppBaseProviders>
        </ConfigProvider>
      </PlatformProvider>
    ),
    root as HTMLElement,
  )
}

startApp()
