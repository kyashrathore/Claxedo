// Claxedo owns the app shell here so auth, hosted routes, query persistence, and the Workbench layout are mounted directly.
import "@/index.css"
import "@/claxedo-ui/ui-overrides.css"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Font } from "@opencode-ai/ui/font"
import { ThemeProvider } from "@opencode-ai/ui/theme"
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
import { GlobalSyncProvider } from "@/context/global-sync"
import { PermissionProvider } from "@/context/permission"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { normalizeServerUrl, ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { NotificationProvider } from "@/context/notification"
import { ModelsProvider } from "@/context/models"
import { CommandProvider } from "@/context/command"
import { LanguageProvider, useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { HighlightsProvider } from "@/context/highlights"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "@/pages/error"
import { getClaxedoServerUrl, isDemoMode, isHostedAppHostname } from "@/utils/api"
import { QueryClientProvider } from "@tanstack/solid-query"
import { useCheckServerHealth } from "@/utils/server-health"
import { ClaxedoSplash } from "@/claxedo-ui/components/claxedo-logo"
import { CloudAutoSwitch } from "@/components/cloud-auto-switch"
import { useConfigOptional } from "@/context/config"
import { centralTransportForServer } from "@/shell/data/transport/transport"
import { useAuthSession } from "./shell/auth/auth-session"
import { PrincipalProvider } from "./shell/auth/principal-provider"
import { queryClient } from "./shared/query/query-client"
import { installQueryPersister } from "./shared/query/persister"
import { installSessionStatusTelemetryDevtools } from "./session/store/session-status-telemetry"

// Cold-launch perf: defer the query persister install (subscribe + JSON.parse
// of the persisted blob) past first paint via requestIdleCallback. Queries
// that race the restore simply cache-miss and refetch — the existing behavior
// when the persisted cache is stale or missing — so deferring is safe.
installQueryPersister({ deferToIdle: true })
// Rubric Q8: attach the polling-removal-gate devtools accessor at boot.
// Self-gated by __CLAXEDO_DEBUG__ / CLAXEDO_DEBUG=1 — no-op in production.
installSessionStatusTelemetryDevtools()

// File/diff viewer pulls @pierre/diffs + the shiki highlighter (~124KB gz
// shared with the review surface). It only renders inside lazy session/review
// surfaces, so load it lazily; the Suspense wrapper keeps useFileComponent
// consumers unchanged. NOTE: this is only effective together with the lazy
// ReviewWorkspace edge in rail-layout — both are eager roots into pierre/shiki.
const LazyFile = lazy(() => import("@/session-client").then((m) => ({ default: m.File as Component<any> })))
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
type ClaxedoAppShellComponent = Component<ParentProps>
const [claxedoAppShell, setClaxedoAppShell] = createSignal<ClaxedoAppShellComponent>()
const [claxedoAppShellPainted, setClaxedoAppShellPainted] = createSignal(false)
let claxedoAppShellLoad: Promise<ClaxedoAppShellComponent> | undefined

const preloadClaxedoAppShell = () => {
  claxedoAppShellLoad ??= import("@/shell/app-shell").then((m) => {
    setClaxedoAppShell(() => m.ClaxedoAppShell)
    return m.ClaxedoAppShell
  })
  return claxedoAppShellLoad
}

function ClaxedoAppShellHost(props: ParentProps) {
  const AppShell = claxedoAppShell()
  let didSignalPaint = false
  createEffect(() => {
    if (!AppShell || didSignalPaint) return
    didSignalPaint = true
    void waitForLayoutRevealFrame().then(() => setClaxedoAppShellPainted(true))
  })
  return AppShell ? <AppShell>{props.children}</AppShell> : null
}

function waitForLayoutRevealFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 0)
  })
}

const Home = lazy(() => import("@/pages/home"))
const PermissionsPage = lazy(() => import("@/pages/permissions"))
const ConfigPage = lazy(() => import("@/pages/config"))
const LoginPage = lazy(() => import("@/pages/login"))
const CliLoginPage = lazy(() => import("@/pages/cli-login"))
const DialogMatrixHarness = lazy(() => import("@/pages/dialog-matrix-harness"))
const ErrorPageHarness = lazy(() => import("@/pages/error-page-harness"))
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
    __OPENCODE__?: {
      updaterEnabled?: boolean
      serverPassword?: string
      serverUrl?: string
      activeDirectory?: string
      deepLinks?: string[]
      wsl?: boolean
      debugTerminal?: boolean
      perfEnabled?: boolean
      perfPath?: string | null
      perf?: DesktopPerf
    }
  }
}

function MarkedProviderWithNativeParser(props: ParentProps) {
  const platform = usePlatform()
  return <MarkedProvider nativeParser={platform.parseMarkdown}>{props.children}</MarkedProvider>
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <LanguageProvider>
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
    const layoutReady = preloadClaxedoAppShell()
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
  const showBlockingSplash = () => mode() === "blocking" && (!readyToRender() || (startup() === true && !claxedoAppShellPainted()))

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
      <CloudAuthGate>
        <Show when={config?.authEnabled} fallback={props.children}>
          <CloudAutoSwitch>{props.children}</CloudAutoSwitch>
        </Show>
      </CloudAuthGate>
    </PrincipalProvider>
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
    if (props.defaultServer) return props.defaultServer as string
    if (stored) return stored
    if (isHostedAppHostname(location.hostname)) return getClaxedoServerUrl()
    const backendUrl = getClaxedoServerUrl()
    return normalizeServerUrl(backendUrl) ?? backendUrl
  }

  const defaultServer = ServerConnection.Key.make(resolveDefaultUrl())

  return (
    <ServerProvider defaultServer={defaultServer} servers={props.servers}>
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

      {import.meta.env.DEV ? (
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
