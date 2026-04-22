import "@/index.css"
import "@claxedo/claxedo-ui/styles.css"
import { AppearanceSync, applyAppearanceOverrides } from "../components/settings-appearance"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { ThemeProvider } from "@opencode-ai/ui/theme"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Router, Route, Navigate } from "@solidjs/router"
import { Effect } from "effect"
import {
  type Component,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentComponent,
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
import { BrowserCommentsProvider } from "../browser/store/browser-comments"
import { BrowserHistoryProvider } from "../browser/store/browser-history"
import { ModelsProvider } from "@/context/models"
import { CommandProvider } from "@/context/command"
import { LanguageProvider, useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { HighlightsProvider } from "@/context/highlights"
import DefaultLayout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "@/pages/error"
import { getExtensions } from "@opencode-ai/app-shared"
import { isDemoMode } from "@claxedo/utils/api"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { useCheckServerHealth } from "@/utils/server-health"
import { ClaxedoSplash } from "@claxedo/claxedo-ui/components/claxedo-logo"

// Apply persisted appearance overrides (CSS classes, UI font size) immediately
applyAppearanceOverrides()

const Home = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const PermissionsPage = lazy(() => import("@claxedo/pages/permissions"))
const ConfigPage = lazy(() => import("@claxedo/pages/config"))
const Loading = () => <div class="size-full" />

// Extension helper: PassThrough component for default auth guard
const PassThrough: ParentComponent = (p) => <>{p.children}</>

// Extension helper: wrap children with a list of providers
function wrapProviders(providers: ParentComponent[] | undefined, children: JSX.Element): JSX.Element {
  return (providers ?? []).reduceRight<JSX.Element>((acc, Provider) => <Provider>{acc}</Provider>, children)
}

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
  return (
    <MarkedProvider nativeParser={platform.parseMarkdown} mermaidRenderer={platform.renderMermaid}>
      {props.children}
    </MarkedProvider>
  )
}

const day = 1000 * 60 * 60 * 24
const week = day * 7

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      gcTime: week,
    },
  },
})

// const persister = createSyncStoragePersister({
//   storage: window.localStorage,
//   key: "OPENCODE_QUERY_CACHE", // Explicit key for easier debugging
//   throttleTime: 250,
// })

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <QueryClientProvider client={queryClient}>
        {/* <SolidQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" /> */}
        <ThemeProvider>
          <AppearanceSync />
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

function ServerKey(props: ParentProps) {
  const server = useServer()
  const platform = usePlatform()
  return (
    <Show when={platform.platform === "web" || server.key} keyed>
      {props.children}
    </Show>
  )
}

function ConnectionGate(props: ParentProps) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()
  const [mode, setMode] = createSignal<"blocking" | "background">("blocking")

  const [startup, actions] = createResource(() =>
    Effect.gen(function* () {
      if (!server.current) return true
      const { http, type } = server.current

      while (true) {
        const res = yield* Effect.promise(() => checkServerHealth(http))
        if (res.healthy) return true
        if (mode() === "background" || type === "http") return false
      }
    }).pipe(
      Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
      Effect.ensuring(Effect.sync(() => setMode("background"))),
      Effect.runPromise,
    ),
  )

  return (
    <Show
      when={mode() === "blocking" ? !startup.loading : startup.state !== "pending"}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <ClaxedoSplash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
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
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const server = useServer()
  const others = () => server.list.filter((item) => ServerConnection.key(item) !== server.key)

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

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

function AuthenticatedLayout(
  props: ParentProps & { defaultServer?: ServerConnection.Key; servers?: Array<ServerConnection.Any> },
) {
  const platform = usePlatform()
  const ext = getExtensions()
  const AuthGuard = ext.app.authGuard ?? PassThrough
  const Layout = ext.app.layoutComponent ?? DefaultLayout

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
    if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
    if (import.meta.env.DEV) {
      const backendUrl = (import.meta.env.VITE_OPENCODE_BACKEND_URL as string | undefined)?.trim()
      if (backendUrl) return normalizeServerUrl(backendUrl) ?? backendUrl
      return normalizeServerUrl(window.location.origin) ?? "http://127.0.0.1:4096"
    }

    return window.location.origin
  }

  const defaultServer = ServerConnection.Key.make(resolveDefaultUrl())

  return (
    <ServerProvider defaultServer={defaultServer} servers={props.servers}>
      {wrapProviders(
        ext.app.authenticatedProviders,
        <AuthGuard>
          <ServerKey>
            <ConnectionGate>
              <GlobalSDKProvider>
                <GlobalSyncProvider>
                  <SettingsProvider>
                    <PermissionProvider>
                      <LayoutProvider>
                        <NotificationProvider>
                          <BrowserCommentsProvider>
                            <BrowserHistoryProvider>
                              <ModelsProvider>
                                <CommandProvider>
                                  <HighlightsProvider>
                                    <Layout>{props.children}</Layout>
                                  </HighlightsProvider>
                                </CommandProvider>
                              </ModelsProvider>
                            </BrowserHistoryProvider>
                          </BrowserCommentsProvider>
                        </NotificationProvider>
                      </LayoutProvider>
                    </PermissionProvider>
                  </SettingsProvider>
                </GlobalSyncProvider>
              </GlobalSDKProvider>
            </ConnectionGate>
          </ServerKey>
        </AuthGuard>,
      )}
    </ServerProvider>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
}) {
  const ext = getExtensions()
  const routes = ext.app.routes ?? []
  const base = isDemoMode() ? "/demo" : undefined
  const RouterComponent = props.router ?? Router

  return wrapProviders(
    ext.app.providers,
    <RouterComponent base={base}>
      {/* Extension routes (e.g. /login from cloud package) */}
      <For each={routes}>{(route) => <Route path={route.path} component={route.component} />}</For>

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
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/new" component={() => <Navigate href=".." />} />
          <Route path="/tab/:tabId" component={() => <div class="hidden" />} />
          <Route
            path="/session/:id?"
            component={(p) => (
              <Show when={p.params.id ?? "new"}>
                <Suspense fallback={<Loading />}>
                  <Session />
                </Suspense>
              </Show>
            )}
          />
          <Route path="/page/:pageId" component={() => <div class="hidden" />} />
        </Route>
      </Route>
    </RouterComponent>,
  )
}
