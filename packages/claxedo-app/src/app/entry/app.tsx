// Claxedo owns the app shell here so auth, hosted routes, query persistence, and the Workbench layout are mounted directly.
import "@/app/styles/index.css"
import "@/app/styles/ui-overrides.css"
import "@/app/integrations/feature-ports"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Font } from "@opencode-ai/ui/font"
import { ThemeProvider } from "@opencode-ai/ui/theme"
import { syncIconLibraryWithTheme } from "@/ui/icons/config"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Router, Route, Navigate, useLocation, useNavigate } from "@solidjs/router"
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { GlobalSyncProvider } from "@/app/providers/global-sync/provider"
import { PermissionProvider } from "@/features/session/providers/permission"
import { LayoutProvider } from "@/app/providers/layout"
import { GlobalSDKProvider } from "@/app/providers/global-sdk/provider"
import { normalizeServerUrl, ServerConnection, ServerProvider, serverName, useServer } from "@/app/connection/server"
import { SettingsProvider } from "@/platform/settings/provider"
import { NotificationProvider } from "@/app/providers/notification"
import { ModelsProvider } from "@/features/session/providers/models"
import { CommandProvider } from "@/app/providers/command"
import { LanguageProvider, useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { HighlightsProvider } from "@/features/review/providers/highlights"
import DirectoryLayout from "@/app/routes/directory-layout"
import { ErrorPage } from "@/app/routes/error"
import { getClaxedoServerUrl, isDemoMode, isHostedAppHostname } from "@/platform/api/api"
import { QueryClientProvider } from "@tanstack/solid-query"
import { useCheckServerHealth } from "@/app/connection/server-health"
import { ClaxedoSplash } from "@/ui/controls/claxedo-logo"
import { CloudAutoSwitch } from "@/features/workspaces/ui/cloud-auto-switch"
import { useConfigOptional } from "@/app/providers/config"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { useAuthSession } from "@/platform/auth/auth-session"
import { PrincipalProvider } from "@/platform/auth/principal-provider"
import { queryClient } from "@/platform/query/query-client"
import { installQueryPersister } from "@/platform/query/persister"
import { installSessionStatusTelemetryDevtools } from "../../features/session/store/session-status-telemetry"
import { getExtensions } from "@/features/extensions"
import { RemoteAccessMarkerRecorder } from "@/features/onboarding"
import { TelemetryIdentityRecorder } from "@/app/integrations/telemetry-identity"
import { ClaxedoEventsProvider } from "@/app/integrations/claxedo-events"

// Restore navigation data before the shell mounts so the sidebar can paint its
// last-known session rows while the local server refresh runs in the background.
installQueryPersister()
// Rubric Q8: attach the polling-removal-gate devtools accessor at boot.
// Self-gated by __CLAXEDO_DEBUG__ / CLAXEDO_DEBUG=1 — no-op in production.
installSessionStatusTelemetryDevtools()

// File/diff viewer pulls @pierre/diffs + the shiki highlighter (~124KB gz
// shared with the review surface). It only renders inside lazy session/review
// surfaces, so load it lazily; the Suspense wrapper keeps useFileComponent
// consumers unchanged. NOTE: this is only effective together with the lazy
// ReviewWorkspace edge in rail-layout — both are eager roots into pierre/shiki.
const LazyFile = lazy(() => import("@/ui/session-kit").then((m) => ({ default: m.File as Component<any> })))
const File: Component<any> = (props) => (
  <Suspense fallback={null}>
    <LazyFile {...props} />
  </Suspense>
)

// The whole workbench shell (rail layout + workspace panels + content surfaces +
// process-pane/zod, review, multi-pane) is the bulk of the eager main chunk. It
// only renders once ConnectionGate resolves, and the gate already shows a splash
// while polling server health — so lazy-load it and make the gate wait for the
// preload promise before revealing children. The chunk downloads during the
// connection handshake, and the existing splash remains continuous until both
// server health and the layout chunk are ready.
const ClaxedoAppShellHost = lazy(() =>
  import("@/app/app-shell").then((module) => ({ default: module.ClaxedoAppShell })),
)
void ClaxedoAppShellHost.preload().catch(() => undefined)

/**
 * Wait one frame before revealing the shell, but never wait forever.
 *
 * The frame exists to avoid revealing a half-laid-out shell. The timeout exists
 * because `requestAnimationFrame` does not fire at all in a hidden document —
 * browsers suspend it for background tabs and occluded windows. The previous
 * fallback only covered rAF being ABSENT, so when it was present-but-suspended
 * this promise never settled and the blocking splash covered the app
 * indefinitely. Loading while backgrounded was
 * enough to reproduce it; it self-heals on focus, which is why it reads as a
 * mystery rather than a hang.
 *
 * Racing the two is safe: the timeout only wins when no frame is coming, and in
 * that case there is nothing to smooth over.
 */
const LAYOUT_REVEAL_TIMEOUT_MS = 250

function waitForLayoutRevealFrame() {
  return new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(done)
    setTimeout(done, typeof requestAnimationFrame === "function" ? LAYOUT_REVEAL_TIMEOUT_MS : 0)
  })
}

const Home = lazy(() => import("@/app/routes/home"))
const PermissionsPage = lazy(() => import("@/app/routes/permissions"))
const ConfigPage = lazy(() => import("@/app/routes/config"))
const LoginPage = lazy(() => import("@/app/routes/login"))
const CliLoginPage = lazy(() => import("@/app/routes/cli-login"))
const DialogMatrixHarness = lazy(() => import("@/app/routes/dialog-matrix-harness"))
const ErrorPageHarness = lazy(() => import("@/app/routes/error-page-harness"))
const Loading = () => <div class="size-full" />
const HiddenRouteOutlet = () => <div class="hidden" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.locale, t: language.t }}>{props.children}</I18nProvider>
}

type DesktopPerf = {
  enabled: boolean
  mark: (name: string, data?: unknown) => void
  span: <T>(name: string, fn: () => Promise<T>, data?: unknown) => Promise<T>
}

declare global {
  interface Window {
    __NOSYNC__?: boolean
    __OPENCODE__?: {
      updaterEnabled?: boolean
      packaged?: boolean
      serverPassword?: string
      serverUrl?: string
      activeDirectory?: string
      deepLinks?: string[]
      wsl?: boolean
      debugTerminal?: boolean
      perfEnabled?: boolean
      perfPath?: string | null
      perf?: DesktopPerf
      startupIsolationStage?: string
    }
  }
}

function MarkedProviderWithNativeParser(props: ParentProps) {
  return <MarkedProvider>{props.children}</MarkedProvider>
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <QueryClientProvider client={queryClient}>
        {/* Codex is the app's default theme — it is the one the rest of the app's
            chrome is designed against (see the `html[data-theme="codex"]` blocks
            in styles/ui-overrides.css). Set here rather than by changing the
            "oc-2" fallback inside @opencode-ai/ui, so the shared package keeps its
            own default for other consumers. A stored THEME_ID still wins, so this
            only applies to users who have never picked a theme. */}
        <ThemeProvider defaultTheme="codex" onThemeApplied={syncIconLibraryWithTheme}>
          <LanguageProvider strings={getExtensions().app.strings}>
            <UiI18nBridge>
              <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
                <DialogProvider>
                  <MarkedProviderWithNativeParser>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </MarkedProviderWithNativeParser>
                </DialogProvider>
              </ErrorBoundary>
            </UiI18nBridge>
          </LanguageProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps) {
  const location = useLocation()
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()
  const [mode, setMode] = createSignal<"blocking" | "background">("blocking")

  const [startup, actions] = createResource(async () => {
    const layoutReady = ClaxedoAppShellHost.preload()
    if (!server.current) {
      await layoutReady
      await waitForLayoutRevealFrame()
      return true
    }
    const { http, type } = server.current
    const revealBeforeHealth = location.pathname.startsWith("/s/") || location.pathname.startsWith("/w/")

    // Poll until healthy, or give up after 10s — then drop to background mode.
    // (Plain async replaces an Effect.gen loop + timeoutOrElse + ensuring.)
    const poll = (async () => {
      while (true) {
        const res = await checkServerHealth(http)
        if (res.healthy) return true
        if (mode() === "background" || type === "http") return false
      }
    })()
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))
    if (revealBeforeHealth) {
      void Promise.race([poll, timeout]).then((healthy) => {
        if (!healthy) setMode("background")
      })
      await layoutReady
      await waitForLayoutRevealFrame()
      return true
    }
    const healthy = await Promise.race([poll, timeout])
    if (!healthy) {
      setMode("background")
      return false
    }
    await layoutReady
    await waitForLayoutRevealFrame()
    return true
  })

  createEffect(() => {
    if (mode() !== "background") return
    if (server.healthy() !== true) return
    actions.refetch()
  })

  const readyToRender = () => mode() === "blocking" ? !startup.loading : startup.state !== "pending"
  const showBlockingSplash = () => mode() === "blocking" && !readyToRender()

  return (
    <>
      <Show when={readyToRender()}>
        <Show
          when={startup()}
          fallback={
            <ConnectionError
              onRetry={() => {
                if (mode() === "background") actions.refetch()
              }}
              onServerSelected={(key) => {
                setMode("blocking")
                server.setActive(key)
                actions.refetch()
              }}
            />
          }
        >
          {props.children}
        </Show>
      </Show>
      <Show when={showBlockingSplash()}>
        <div class="fixed inset-0 z-[9999] h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <ClaxedoSplash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      </Show>
    </>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const server = useServer()
  const others = () => server.list.filter((item) => ServerConnection.key(item) !== server.key)

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <ClaxedoSplash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          Could not reach <span class="text-text-strong font-medium">{server.name || server.key}</span>
        </p>
        <p class="mt-1 text-12-regular text-text-weak">Retrying automatically...</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">Other servers</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

/**
 * e2e-only runtime override for the resolved default server URL. Returns a
 * spec-supplied `window.__CLAXEDO_E2E_SERVER_URL__` only in a dev/e2e build so
 * a Playwright spec can drive a non-loopback transport (making
 * `CloudAuthGate`'s `needsSignedAuth()` true) without a separate hosted
 * harness. A real production build sets neither flag, so this folds to
 * `undefined` and is eliminated — no production behavior change.
 */
function e2eServerUrlOverride(): string | undefined {
  if (!(import.meta.env.DEV || import.meta.env.VITE_CLAXEDO_E2E === "1")) return undefined
  if (typeof window === "undefined") return undefined
  const url = (window as typeof window & { __CLAXEDO_E2E_SERVER_URL__?: string }).__CLAXEDO_E2E_SERVER_URL__
  return typeof url === "string" && url.trim() ? url.trim() : undefined
}

function CloudAuthGate(props: ParentProps) {
  const config = useConfigOptional()
  const session = useAuthSession()
  const server = useServer()
  const location = useLocation()
  const navigate = useNavigate()
  const authEnabled = () => config?.authEnabled === true
  const needsSignedAuth = () => authEnabled() && centralTransportForServer(server.url) !== "loopback"
  const canRender = () => !needsSignedAuth() || session.status() === "signed"

  createEffect(() => {
    if (!needsSignedAuth()) return
    if (session.status() !== "anonymous") return
    if (location.pathname === "/login") return
    navigate("/login", { replace: true })
  })

  return (
    <Show
      when={canRender()}
      fallback={<div class="size-full flex items-center justify-center">Loading...</div>}
    >
      {props.children}
    </Show>
  )
}

function AuthenticatedProviders(props: ParentProps) {
  const config = useConfigOptional()

  return (
    <PrincipalProvider authEnabled={config?.authEnabled === true}>
      <TelemetryIdentityRecorder />
      <RemoteAccessMarkerRecorder />
      <CloudAuthGate>
        <Show when={config?.authEnabled} fallback={props.children}>
          <CloudAutoSwitch>{props.children}</CloudAutoSwitch>
        </Show>
      </CloudAuthGate>
    </PrincipalProvider>
  )
}

function RoutedClaxedoEventsProvider(props: ParentProps) {
  const location = useLocation()
  const server = useServer()

  return (
    <ClaxedoEventsProvider pathname={() => location.pathname} serverUrl={() => server.url}>
      {props.children}
    </ClaxedoEventsProvider>
  )
}

function AuthenticatedLayout(
  props: ParentProps & { defaultServer?: ServerConnection.Key; servers?: Array<ServerConnection.Any> },
) {
  const platform = usePlatform()

  const stored = (() => {
    if (platform.platform !== "web") return
    const result = platform.getDefaultServer?.()
    if (result instanceof Promise) return
    if (!result) return
    return result
  })()

  const resolveDefaultUrl = () => {
    // Demo mode: use current origin so MSW service worker intercepts all requests
    if (isDemoMode()) return window.location.origin
    // e2e-only: let a spec force a non-loopback default server so the
    // signed-auth redirect boundary (CloudAuthGate → /login for an anonymous
    // principal on a non-loopback transport) is provable. Gated to the dev
    // server / prebuilt e2e build; a real production build sets neither flag,
    // so this constant-folds away and the window read is tree-shaken out.
    const e2eServer = e2eServerUrlOverride()
    if (e2eServer) return e2eServer
    if (props.defaultServer) return props.defaultServer as string
    if (stored) return stored
    if (isHostedAppHostname(location.hostname)) return getClaxedoServerUrl()
    const backendUrl = getClaxedoServerUrl()
    return normalizeServerUrl(backendUrl) ?? backendUrl
  }

  const defaultServer = ServerConnection.Key.make(resolveDefaultUrl())

  return (
    <ServerProvider defaultServer={defaultServer} servers={props.servers}>
      <RoutedClaxedoEventsProvider>
        <AuthenticatedProviders>
          <ConnectionGate>
            <GlobalSDKProvider>
              <GlobalSyncProvider>
                <SettingsProvider>
                  <PermissionProvider>
                    <LayoutProvider>
                      <NotificationProvider>
                        <ModelsProvider>
                          <CommandProvider>
                            <HighlightsProvider>
                              <ClaxedoAppShellHost>
                                {props.children}
                              </ClaxedoAppShellHost>
                            </HighlightsProvider>
                          </CommandProvider>
                        </ModelsProvider>
                      </NotificationProvider>
                    </LayoutProvider>
                  </PermissionProvider>
                </SettingsProvider>
              </GlobalSyncProvider>
            </GlobalSDKProvider>
          </ConnectionGate>
        </AuthenticatedProviders>
      </RoutedClaxedoEventsProvider>
    </ServerProvider>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
}) {
  const base = isDemoMode() ? "/demo" : undefined
  const RouterComponent = props.router ?? Router

  return (
    <RouterComponent base={base}>
      <Route
        path="/login"
        component={() => (
          <Suspense fallback={<Loading />}>
            <LoginPage />
          </Suspense>
        )}
      />
      <Route
        path="/cli-login"
        component={() => (
          <Suspense fallback={<Loading />}>
            <CliLoginPage />
          </Suspense>
        )}
      />
      {import.meta.env.DEV ? (
        <Route
          path="/__e2e/dialog-matrix"
          component={() => (
            <Suspense fallback={<Loading />}>
              <DialogMatrixHarness />
            </Suspense>
          )}
        />
      ) : null}

      {import.meta.env.DEV || import.meta.env.VITE_CLAXEDO_E2E === "1" ? (
        <Route
          path="/__e2e/error-page"
          component={() => (
            <Suspense fallback={<Loading />}>
              <ErrorPageHarness />
            </Suspense>
          )}
        />
      ) : null}

      <Route
        path="/"
        component={(p) => (
          <AuthenticatedLayout {...p} defaultServer={props.defaultServer} servers={props.servers} />
        )}
      >
        <Route
          path="/"
          component={() => (
            <Suspense fallback={<Loading />}>
              <Home />
            </Suspense>
          )}
        />
        <Route
          path="/permissions"
          component={() => (
            <Suspense fallback={<Loading />}>
              <PermissionsPage />
            </Suspense>
          )}
        />
        <Route
          path="/config"
          component={() => (
            <Suspense fallback={<Loading />}>
              <ConfigPage />
            </Suspense>
          )}
        />
        <Route path="/s/:sessionId" component={HiddenRouteOutlet} />
        <Route path="/marketplace" component={HiddenRouteOutlet} />
        <Route path="/workgraph" component={HiddenRouteOutlet} />
        <Route path="/w/:workspaceId/session" component={HiddenRouteOutlet} />
        <Route path="/w/:workspaceId/session/:sessionId" component={HiddenRouteOutlet} />
        <Route path="/w/:workspaceId/page/:pageId" component={HiddenRouteOutlet} />
        <Route path="/w/:workspaceId/terminal/:terminalId" component={HiddenRouteOutlet} />
        <Route path="/w/:workspaceId" component={HiddenRouteOutlet} />
        <Route path="/w/*workspaceRoute" component={HiddenRouteOutlet} />
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/new" component={() => <Navigate href=".." />} />
          <Route path="/session/:id?" component={HiddenRouteOutlet} />
          <Route path="/page/:pageId" component={HiddenRouteOutlet} />
          <Route path="/terminal/:terminalId" component={HiddenRouteOutlet} />
        </Route>
      </Route>
    </RouterComponent>
  )
}
