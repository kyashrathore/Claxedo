import { createAsyncState } from "@/lib/async-state"
// Claxedo owns the app shell here so auth, hosted routes, query persistence, and the Workbench layout are mounted directly.
import { rendererTraceEnabled } from "@/platform/performance/renderer-trace"
import "@/app/styles/index.css"
import "@/app/styles/ui-overrides.css"
// The v2 overlay component sheets ride the eager bundle on purpose: they are
// the declared consumers of the theme geometry tokens ui-overrides.css binds
// (`--surface-overlay-radius`/`--surface-overlay-shadow` — see
// src/architecture/codex-theme.guard.test.ts "keeps every Codex geometry input
// connected to its component declaration"). Importing only the components
// lazily let code-splitting move these sheets into the composer/markdown
// chunks, so any surface rendered before those chunks load (and the theme
// contract itself) saw the overlay geometry silently fall to 0. Vite dedupes:
// the lazy chunks reuse this eager copy instead of emitting a second one.
import "@opencode-ai/ui/v2/menu-v2.css"
import "@opencode-ai/ui/v2/select-v2.css"
import "@opencode-ai/ui/v2/tooltip-v2.css"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { Font } from "@opencode-ai/ui/font"
import { ThemeProvider } from "@opencode-ai/ui/theme"
import { syncIconLibraryWithTheme } from "@/ui/icons/config"
import { createRouter, defineRoutes, type RouterProps, useLocation, useNavigate } from "@solidjs/router"
import {
  type Component,
  createContext,
  createTrackedEffect,
  createSignal,
  Errored,
  For,
  lazy,
  type ParentProps,
  Show,
  Loading,
  useContext,
} from "solid-js"
import type { JSX } from "@solidjs/web"
import { normalizeServerUrl, ServerConnection, ServerProvider, serverName, useServer } from "@/app/connection/server"
import { LanguageProvider, useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { ErrorPage } from "@/app/routes/error"
import { getClaxedoServerUrl, isDemoMode, isHostedAppHostname } from "@/platform/api/api"
import { QueryClientProvider } from "@tanstack/solid-query"
import { useCheckServerHealth } from "@/app/connection/server-health"
import { ClaxedoSplash } from "@/ui/controls/claxedo-logo"
import { useConfigOptional } from "@/app/providers/config"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { useAuthSession } from "@/platform/auth/auth-session"
import { PrincipalProvider } from "@/platform/auth/principal-provider"
import { AccountPortProvider } from "@/platform/account/account-provider"
import { queryClient } from "@/platform/query/query-client"
import { installQueryPersister } from "@/platform/query/persister"
import { installSessionStatusTelemetryDevtools } from "../../features/session/store/session-status-telemetry"
import { getExtensions } from "@/features/extensions"
import { RemoteAccessMarkerRecorder } from "@/features/onboarding/remote-access-marker"
import { TelemetryIdentityRecorder } from "@/app/integrations/telemetry-identity"
import { HostedContributionSync } from "@/app/composition/hosted-contribution-sync"
import { ClaxedoEventsProvider } from "@/app/integrations/claxedo-events"
import { loadFileComponent } from "@/ui/session-kit-loaders"

if (rendererTraceEnabled()) {
  performance.mark("runtime.appEntryModuleEvaluated")
}

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
const LazyFile = lazy(() => loadFileComponent().then((File) => ({ default: File as Component<any> })))
const File: Component<any> = (props) => (
  <Loading fallback={null}>
    <LazyFile {...props} />
  </Loading>
)

const [claxedoAppShellPainted, setClaxedoAppShellPainted] = createSignal(false)
const RuntimeProviders = lazy(() =>
  import("./runtime-providers").then((module) => ({ default: module.RuntimeProviders })),
)
const preloadClaxedoAppShell = () => import("./runtime-providers").then((module) => module.preloadRuntimeProviders())

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
const DirectoryLayout = lazy(() => import("@/app/routes/directory-layout"))
const PermissionsPage = lazy(() => import("@/app/routes/permissions"))
const ConfigPage = lazy(() => import("@/app/routes/config"))
const LoginPage = lazy(() => import("@/app/routes/login"))
const CliLoginPage = lazy(() => import("@/app/routes/cli-login"))
const DialogMatrixHarness = lazy(() => import("@/app/routes/dialog-matrix-harness"))
const ErrorPageHarness = lazy(() => import("@/app/routes/error-page-harness"))
const RouteLoading = () => <div class="size-full" />
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
  const platform = usePlatform()
  return <MarkedProvider nativeParser={platform.parseMarkdown}>{props.children}</MarkedProvider>
}

export function AppBaseProviders(props: ParentProps) {
  return (
    <>
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
              <Errored fallback={(error) => <ErrorPage error={error()} />}>
                <DialogProvider>
                  <MarkedProviderWithNativeParser>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </MarkedProviderWithNativeParser>
                </DialogProvider>
              </Errored>
            </UiI18nBridge>
          </LanguageProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </>
  )
}

function ConnectionGate(props: ParentProps) {
  const location = useLocation()
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()
  const [mode, setMode] = createSignal<"blocking" | "background">("blocking")

  const startup = createAsyncState(async () =>
    (async () => {
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
    })(),
  )
  createTrackedEffect(() => {
    if (mode() !== "background") return
    if (server.healthy() !== true) return
    startup.refresh()
  })

  const readyToRender = () =>
    mode() === "blocking" ? !startup.loading() : startup.data() !== undefined || !startup.loading()
  const showBlockingSplash = () => mode() === "blocking" && !readyToRender()

  return (
    <>
      <Show when={readyToRender()}>
        <Show
          when={startup.data()}
          fallback={
            <ConnectionError
              onRetry={() => {
                if (mode() === "background") startup.refresh()
              }}
              onServerSelected={(key) => {
                setMode("blocking")
                server.setActive(key)
                startup.refresh()
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

  createTrackedEffect(() => {
    if (!needsSignedAuth()) return
    if (session.status() !== "anonymous") return
    if (location.pathname === "/login") return
    navigate("/login", { replace: true })
  })

  return (
    <Show when={canRender()} fallback={<div class="size-full flex items-center justify-center">Loading...</div>}>
      {props.children}
    </Show>
  )
}

/**
 * Automatically restores workspace routing when navigating directly to a cloud
 * session URL that requires connection to a cloud sandbox. Lives in the app
 * layer (its only mount point) and reads `useServer` from the connection
 * provider directly: it renders ABOVE `RuntimeProviders`, i.e. before the
 * lazily-imported `app/integrations/feature-ports` wiring has evaluated, so it
 * must not go through the workspaces app-ports proxy — that proxy throws
 * "Workspaces app ports are not configured" until the wiring lands, which
 * crashed boot whenever `authEnabled` resolved first on a cold load.
 */
function CloudAutoSwitch(props: ParentProps) {
  const server = useServer()

  createTrackedEffect(() => {
    const current = server.url
    if (/^https?:\/\/[^/]+\/(w|s)\//.test(current)) {
      const origin = current.split("/").slice(0, 3).join("/")
      if (origin) server.setActive(origin)
    }
  })

  return <>{props.children}</>
}

function AuthenticatedProviders(props: ParentProps) {
  const config = useConfigOptional()

  return (
    <PrincipalProvider authEnabled={config?.authEnabled === true}>
      {/* Inside PrincipalProvider so both read one session, and above every
          account surface so none of them reaches the session directly. */}
      <AccountPortProvider>
        <TelemetryIdentityRecorder />
        <RemoteAccessMarkerRecorder />
        {/* Removes the hosted contribution set when the account signs out.
          Before this, hosted surfaces stayed registered until a reload. */}
        <HostedContributionSync />
        <CloudAuthGate>
          <Show when={config?.authEnabled} fallback={props.children}>
            <CloudAutoSwitch>{props.children}</CloudAutoSwitch>
          </Show>
        </CloudAuthGate>
      </AccountPortProvider>
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
  props: ParentProps & {
    defaultServer?: ServerConnection.Key
    servers?: Array<ServerConnection.Any>
    runtimeChildren?: () => JSX.Element
  },
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
            <RuntimeProviders onPainted={() => setClaxedoAppShellPainted(true)}>
              {props.children}
              <RuntimeChildren content={props.runtimeChildren} />
            </RuntimeProviders>
          </ConnectionGate>
        </AuthenticatedProviders>
      </RoutedClaxedoEventsProvider>
    </ServerProvider>
  )
}

type AppInterfaceConfig = {
  defaultServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  runtimeChildren?: () => JSX.Element
}

const AppInterfaceContext = createContext<AppInterfaceConfig>({})

function useAppInterfaceConfig() {
  return useContext(AppInterfaceContext)
}

function LoginRoute() {
  return (
    <AccountPortProvider>
      <Loading fallback={<RouteLoading />}>
        <LoginPage />
      </Loading>
    </AccountPortProvider>
  )
}

function CliLoginRoute() {
  return (
    <Loading fallback={<RouteLoading />}>
      <CliLoginPage />
    </Loading>
  )
}

function DialogMatrixRoute() {
  return (
    <Loading fallback={<RouteLoading />}>
      <DialogMatrixHarness />
    </Loading>
  )
}

function ErrorPageHarnessRoute() {
  return (
    <Loading fallback={<RouteLoading />}>
      <ErrorPageHarness />
    </Loading>
  )
}

function AuthenticatedRoute(props: ParentProps) {
  const config = useAppInterfaceConfig()
  return (
    <AuthenticatedLayout
      defaultServer={config.defaultServer}
      servers={config.servers}
      runtimeChildren={config.runtimeChildren}
    >
      {props.children}
    </AuthenticatedLayout>
  )
}

function RuntimeChildren(props: { content?: () => JSX.Element }) {
  return <>{props.content?.()}</>
}

function HomeRoute() {
  return (
    <Loading fallback={<RouteLoading />}>
      <Home />
    </Loading>
  )
}

function PermissionsRoute() {
  return (
    <Loading fallback={<RouteLoading />}>
      <PermissionsPage />
    </Loading>
  )
}

function ConfigRoute() {
  return (
    <Loading fallback={<RouteLoading />}>
      <ConfigPage />
    </Loading>
  )
}

function SessionIndexRedirect() {
  useNavigate()("session", { replace: true })
  return null
}

function NewSessionRedirect() {
  useNavigate()("..", { replace: true })
  return null
}

export const claxedoRoutes = defineRoutes([
  { path: "/login", component: LoginRoute },
  { path: "/cli-login", component: CliLoginRoute },
  ...(import.meta.env.DEV ? [{ path: "/__e2e/dialog-matrix", component: DialogMatrixRoute } as const] : []),
  ...(import.meta.env.DEV || import.meta.env.VITE_CLAXEDO_E2E === "1"
    ? [{ path: "/__e2e/error-page", component: ErrorPageHarnessRoute } as const]
    : []),
  {
    path: "/",
    component: AuthenticatedRoute,
    children: [
      { path: "/", component: HomeRoute },
      { path: "/permissions", component: PermissionsRoute },
      { path: "/config", component: ConfigRoute },
      { path: "/s/:sessionId", component: HiddenRouteOutlet },
      { path: "/marketplace", component: HiddenRouteOutlet },
      { path: "/workgraph", component: HiddenRouteOutlet },
      {
        path: "/w/:workspaceId",
        component: DirectoryLayout,
        children: [
          { path: "/", component: HiddenRouteOutlet },
          { path: "/session", component: HiddenRouteOutlet },
          { path: "/session/:sessionId", component: HiddenRouteOutlet },
          { path: "/page/:pageId", component: HiddenRouteOutlet },
          { path: "/terminal/:terminalId", component: HiddenRouteOutlet },
          { path: "/*workspaceRoute", component: HiddenRouteOutlet },
        ],
      },
      {
        path: "/:dir",
        component: DirectoryLayout,
        children: [
          { path: "/", component: SessionIndexRedirect },
          { path: "/session/new", component: NewSessionRedirect },
          { path: "/session/:id?", component: HiddenRouteOutlet },
          { path: "/page/:pageId", component: HiddenRouteOutlet },
          { path: "/terminal/:terminalId", component: HiddenRouteOutlet },
        ],
      },
    ],
  },
])

export const AppRouter = createRouter({
  routes: claxedoRoutes,
  base: isDemoMode() ? "/demo" : undefined,
})

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<RouterProps>
}) {
  const RouterComponent = props.router ?? AppRouter

  return (
    <AppInterfaceContext
      value={{
        defaultServer: props.defaultServer,
        servers: props.servers,
        runtimeChildren: () => props.children,
      }}
    >
      <RouterComponent>{(route) => route.children}</RouterComponent>
    </AppInterfaceContext>
  )
}
