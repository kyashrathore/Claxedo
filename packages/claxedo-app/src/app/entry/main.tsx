/**
 * Cloud-specific entry point for Claxedo.
 *
 * This file initializes cloud extensions and renders the OpenCode app
 * with cloud functionality enabled.
 */

// @refresh reload
import { render } from "solid-js/web"
import { lazy, Suspense } from "solid-js"
import { AppBaseProviders, AppInterface } from "@/app/entry/app"
import { PlatformProvider, type Platform } from "@claxedo/app"
import { initClaxedo, getDefaultConfig } from "./index"
import { browserAuthAdapter } from "#browser-auth-adapter"
import {
  authFetch,
  configureApiRuntime,
  getClaxedoServerUrl,
  releaseValidationOperation,
} from "@/platform/api/api"
import { configureAuthSession } from "@/platform/auth/auth-session"
import {
  initPostHog,
  capture as phCapture,
  identityProps,
  resolveDeploymentMode,
  setDeploymentMode,
} from "@/platform/telemetry/analytics"
import { isEmbedMode } from "@/platform/api/api"
import { writeBrowserRoute } from "@/lib/browser-history"
import { openLink } from "@/lib/open-link"
import { ConfigProvider } from "../providers/config"
import { configureWorkspaceStartup } from "@/platform/runtime/workspace-startup"
import { cloudWorkspaceStartup } from "@/platform/runtime/cloud/workspace-runtime-store"
import { configureHttpMachineRemoteAccess } from "@/platform/remote-access/http-machine-remote-access-binding"
import { hostedServiceContributionLoaders } from "@/app/composition/hosted-contribution-loader"
import { startBrowserAuth } from "./browser-auth-startup"
import { resolveDeploymentPosture } from "@/app/boot/data/deployment-posture"

const OAuthConsentPage = lazy(() => import("@/app/routes/oauth-consent"))
const HostedOAuthConsentRoute = () => (
  <Suspense>
    <OAuthConsentPage request={authFetch} apiOrigin={getClaxedoServerUrl()} />
  </Suspense>
)

const DeviceApprovalPage = lazy(() => import("@/app/routes/device-approval"))
const HostedDeviceApprovalRoute = () => (
  <Suspense>
    <DeviceApprovalPage request={authFetch} apiOrigin={getClaxedoServerUrl()} />
  </Suspense>
)

/**
 * Composer and session actions wake a relay-placed runtime through
 * `workspaceStartup()`. `local.tsx` binds nothing: an unsigned local build has
 * no provisioner to wake, so reaching the port there throws.
 */
configureWorkspaceStartup(cloudWorkspaceStartup)

/**
 * Bind machine remote access to this server's own routes.
 *
 * The server this bundle is served from mounts `RemoteAccessRoutes` at
 * `/api/claxedo/remote-access` (`deployments/self-hosted-node/app.ts`), so
 * publishing a machine here IS an authenticated call to this origin.
 *
 * The desktop binds a different implementation over Electron IPC, because its
 * sidecar serves none of those paths — machine publication belongs to the Host
 * Connector in Electron main. `local.tsx` binds nothing, deliberately: a local
 * browser build has neither the routes nor a main process, and the panel says
 * so rather than posting into a 404. That is the bug this seam exists to make
 * impossible.
 *
 * At module scope, beside the other bindings, so a surface that reads the port
 * during its first render does not see it unbound.
 */
configureHttpMachineRemoteAccess((path, init) => authFetch(new URL(path, getClaxedoServerUrl()), init))

/**
 * Bind the identity provider to the authenticated transport.
 *
 * `platform/api/api.ts` stays free of any concrete auth provider import — it
 * lives in `@claxedo/app` while provider implementations belong to hosted
 * composition. The transport binds either a bearer source or cookie
 * credentials from the statically selected adapter; `local.tsx` supplies
 * neither.
 *
 * At module scope, not inside a component: `authFetch` is called from plain
 * modules during bootstrap, and a binding installed during render would leave
 * the earliest calls unauthenticated.
 */
const selectedReleaseValidationOperation = releaseValidationOperation(
  import.meta.env.VITE_CLAXEDO_RELEASE_VALIDATION_OPERATION,
)

configureApiRuntime({
  bearerToken: browserAuthAdapter.transport === "bearer" ? browserAuthAdapter.getToken : null,
  browserCredentials: browserAuthAdapter.transport === "cookie" ? "include" : null,
  releaseValidation: selectedReleaseValidationOperation
    ? {
        coreOrigin: getClaxedoServerUrl(),
        operation: selectedReleaseValidationOperation,
      }
    : null,
})

/**
 * Bind the identity provider to the app's canonical auth-session abstraction.
 *
 * `platform/auth/auth-session.ts` keeps only an `import type` edge to the
 * neutral browser-auth contract, which the bundler erases. A value import
 * would put the auth vendor on the shell's provider tree (`app/entry/app.tsx`
 * mounts it, and both products render that shell), reaching `local.tsx`
 * through `local.tsx -> app/entry/app.tsx -> platform/auth/auth-session.ts ->
 * a provider implementation` — and `local.tsx` can never sign in.
 *
 * `local.tsx` supplies nothing on purpose. Unbound, `useAuthSession()` returns
 * a stable anonymous session rather than throwing — an unsigned local build
 * genuinely is anonymous, and that is the honest value for a call that happens
 * during render. Same asymmetry as `configureApiRuntime` above, and unlike
 * `configureWorkspaceStartup`, whose unbound port throws because waking a
 * hosted sandbox is an operation, not a state.
 *
 * At module scope, not inside a component: the provider tree reads the session
 * on its first render, and a binding installed during render would leave that
 * read anonymous in a hosted build.
 */
configureAuthSession(browserAuthAdapter.useAuth)

// Initialize cloud extensions before rendering
const config = {
  ...getDefaultConfig(),
  // The hosted entry owns the only value edge to the hosted implementations.
  // Supplying the loader here lets Rollup remove the dynamic chunk entirely
  // from local.tsx instead of merely leaving it dormant at runtime.
  serviceContributionLoaders: hostedServiceContributionLoaders,
}
initClaxedo(config)

// Initialize PostHog analytics (no-ops if VITE_POSTHOG_KEY not set)
initPostHog()

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error("Root element not found. Make sure there is an element with id='root' in your index.html")
}

/**
 * Platform configuration for cloud/web mode.
 */
const platform: Platform = {
  platform: "web",
  version: "cloud",
  fetch: authFetch,
  getAuthToken: browserAuthAdapter.getToken,
  openLink,
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
    if (isEmbedMode()) return
    if (!("Notification" in window)) return

    // Never request permission here — turn completion must not trigger the
    // browser's permission prompt. Permission is only ever requested from an
    // explicit Settings toggle interaction (see
    // src/platform/notifications/notification-permission.ts). If the user hasn't decided yet
    // (still "default") or has denied it, silently skip.
    if (Notification.permission !== "granted") return

    const inView = document.visibilityState === "visible" && document.hasFocus()
    if (inView) return

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
          icon: "/favicon-96x96-v3.png",
        })
        notification.onclick = () => {
          window.focus()
          if (href) writeBrowserRoute(href, { replace: false, notify: true })
          notification.close()
        }
      })
      .catch(() => undefined)
  },
}

async function startApp() {
  // The server's posture before anything reads it. `startBrowserAuth` must not
  // load a provider SDK against a central that issues no sessions, and
  // `CloudAuthGate` must not paint an anonymous shell on one that does, so the
  // declaration is resolved here and the whole tree below reads the same
  // cached answer on its first render.
  const issuesSessions = await resolveDeploymentPosture({ baseUrl: getClaxedoServerUrl() })

  // Nothing here waits for it, and nothing here can fail because of it — see
  // `browser-auth-startup.ts`.
  startBrowserAuth({
    issuesSessions,
    adapter: browserAuthAdapter,
    apiOrigin: getClaxedoServerUrl(),
    appOrigin: window.location.origin,
  })

  // This entry is the web build; the desktop renderer resolves its own plane
  // once PlatformProvider mounts (TelemetryIdentityRecorder).
  setDeploymentMode(resolveDeploymentMode({ platform: "web", issuesSessions: issuesSessions === true }))
  phCapture("app_launched", {
    ...identityProps(),
    surface: "app_shell",
    platform: "web",
    version: "cloud",
  })

  // Render the standard app with cloud extensions active
  render(
    () => (
      <ConfigProvider config={config}>
        <PlatformProvider value={platform}>
          <AppBaseProviders>
            <AppInterface oauthConsent={HostedOAuthConsentRoute} deviceApproval={HostedDeviceApprovalRoute} />
          </AppBaseProviders>
        </PlatformProvider>
      </ConfigProvider>
    ),
    root!,
  )
}

/**
 * The last resort, for a state in which no shell can exist at all: `render()`
 * itself threw.
 *
 * Reserved for exactly that. Anything the app can honestly represent as state
 * belongs in the shell instead: "nobody is signed in" is a session status, not
 * a startup failure, and painting this panel for it hides `/login` behind an
 * error box the user cannot act on.
 */
function renderStartupFailure(error: unknown) {
  if (!(root instanceof HTMLElement)) return
  const message = error instanceof Error && error.message ? error.message : "Unknown startup failure"
  root.replaceChildren()
  root.style.backgroundColor = "var(--background-base)"
  root.style.color = "var(--text-base)"
  root.style.minHeight = "100dvh"
  root.style.display = "grid"
  root.style.placeItems = "center"

  const panel = document.createElement("div")
  panel.style.maxWidth = "520px"
  panel.style.padding = "24px"
  panel.style.fontFamily = "var(--font-family-sans)"
  panel.style.lineHeight = "var(--line-height-relaxed)"

  const title = document.createElement("div")
  title.textContent = "Claxedo failed to start"
  title.style.color = "var(--text-strong)"
  title.style.fontSize = "var(--font-size-base)"
  title.style.fontWeight = "var(--font-weight-semibold)"

  const body = document.createElement("pre")
  body.textContent = message
  body.style.margin = "12px 0 0"
  body.style.whiteSpace = "pre-wrap"
  body.style.color = "var(--text-weak)"
  body.style.fontSize = "var(--font-size-small)"

  // Without this the only way out of the panel is knowing to reload by hand.
  const retry = document.createElement("button")
  retry.textContent = "Try again"
  retry.style.marginTop = "16px"
  retry.style.padding = "6px 14px"
  retry.style.borderRadius = "var(--radius-sm)"
  retry.style.border = "1px solid var(--border-base)"
  retry.style.background = "var(--background-element)"
  retry.style.color = "var(--text-base)"
  retry.style.font = "inherit"
  retry.style.cursor = "pointer"
  retry.addEventListener("click", () => window.location.reload())

  panel.append(title, body, retry)
  root.append(panel)
}

void startApp().catch((error) => {
  console.error("[claxedo:boot]", "failed", error)
  renderStartupFailure(error)
})
