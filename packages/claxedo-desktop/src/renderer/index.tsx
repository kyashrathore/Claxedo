// @refresh reload

import "./webview-zoom"
import { AppBaseProviders, AppInterface } from "@/app/entry/app"
import { PlatformProvider } from "@/platform/runtime/platform-provider"
import { ServerConnection } from "@/app/connection/server"
import { useCommand } from "@/app/providers/command"
import type { Platform as AppPlatform } from "@claxedo/app"
import { handleNotificationClick } from "@claxedo/app"
import { ClaxedoSplash } from "@/ui/controls/claxedo-logo"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createResource, type JSX, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter } from "@solidjs/router"
import { useTheme } from "@opencode-ai/ui/theme"

import { desktopApi, hasDesktopApi } from "./api"
import {
  initPostHog,
  capture as phCapture,
  identityProps,
  resolveDeploymentMode,
  setDeploymentMode,
} from "@/platform/telemetry/analytics"
import { ConfigProvider } from "@/app/providers"
import { getAuthToken, getDefaultConfig, initClaxedo } from "@claxedo/app"
import { configureApiRuntime } from "@/platform/api/api"
import type { LinuxDisplayBackend, ServerReadyData } from "../preload/types"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { restartApp } from "./restart"
import { UPDATER_ENABLED } from "./updater"
import { webviewZoom } from "./webview-zoom"
import { isResizeObserverDeliveryError } from "./window-error"
import "./styles.css"

type Platform = AppPlatform & {
  getAuthToken?(): Promise<string | null>
  // Members upstream's Platform carried but claxedo's deliberately dropped
  // (divorce plan 006): the desktop renderer still provides them, and
  // claxedo's PlatformProvider ignores unknown members at runtime.
  getWslEnabled?(): Promise<boolean>
  setWslEnabled?(config: boolean): Promise<void> | void
  getDisplayBackend?(): Promise<LinuxDisplayBackend | null>
  setDisplayBackend?(backend: LinuxDisplayBackend | null): Promise<void>
}

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

void initI18n()

const encode = (reason: unknown) => {
  if (reason instanceof Error) return { name: reason.name, message: reason.message, stack: reason.stack ?? null }
  if (typeof reason === "string") return { message: reason }
  if (reason && typeof reason === "object") {
    try {
      const seen = new WeakSet<object>()
      const json = JSON.stringify(reason, (_, v) => {
        if (v && typeof v === "object") {
          if (seen.has(v as object)) return "[Circular]"
          seen.add(v as object)
        }
        return v
      })
      return { message: json && json !== "{}" ? json : Object.prototype.toString.call(reason), raw: reason }
    } catch {
      return { message: Object.prototype.toString.call(reason) }
    }
  }
  return { message: String(reason) }
}

const showFatal = (label: string, payload: unknown) => {
  window.__OPENCODE__ ??= {}
  ;(window.__OPENCODE__ as unknown as { lastError?: { label: string; payload: unknown } }).lastError = {
    label,
    payload,
  }

  const id = "opencode-fatal"
  const host =
    document.getElementById(id) ??
    (() => {
      const elt = document.createElement("div")
      elt.id = id
      elt.style.position = "fixed"
      elt.style.left = "8px"
      elt.style.right = "8px"
      elt.style.bottom = "8px"
      elt.style.zIndex = "2147483647"
      elt.style.maxHeight = "40vh"
      elt.style.overflow = "auto"
      elt.style.padding = "10px 12px"
      elt.style.borderRadius = "10px"
      elt.style.background = "rgba(0,0,0,0.80)"
      elt.style.color = "white"
      elt.style.fontFamily =
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
      elt.style.fontSize = "12px"
      elt.style.whiteSpace = "pre-wrap"
      elt.style.userSelect = "text"
      elt.style.cursor = "pointer"
      elt.title = "Click to dismiss"
      elt.addEventListener("click", () => elt.remove())
      document.body.appendChild(elt)
      return elt
    })()

  const text = (() => {
    try {
      return `${label}\n${JSON.stringify(payload, null, 2)}`
    } catch {
      return `${label}\n${String(payload)}`
    }
  })()
  host.textContent = text
}

window.addEventListener(
  "error",
  (event) => {
    if (isResizeObserverDeliveryError(event.message)) {
      event.preventDefault()
      return
    }
    const payload = {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: encode(event.error),
    }
    if (import.meta.env.DEV) showFatal("window.error", payload)
  },
  true,
)

window.addEventListener(
  "unhandledrejection",
  (event) => {
    const payload = encode(event.reason)
    if (import.meta.env.DEV) showFatal("unhandledrejection", payload)
    event.preventDefault()
  },
  true,
)

if (hasDesktopApi()) {
  bootstrapDesktop()
} else {
  render(() => <MissingElectronShell />, root!)
}

function bootstrapDesktop() {
  const config = getDefaultConfig()
  initClaxedo(config)

  initPostHog()

  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos" as const
    if (ua.includes("Windows")) return "windows" as const
    if (ua.includes("Linux")) return "linux" as const
    return undefined
  })()

  // The desktop renderer knows its plane synchronously — no provider mount needed.
  setDeploymentMode(resolveDeploymentMode({ platform: "desktop", authEnabled: config.authEnabled === true }))
  phCapture("app_launched", {
    ...identityProps(),
    surface: "app_shell",
    platform: "desktop",
    version: pkg.version,
    os,
  })

  const originalGetComputedStyle = window.getComputedStyle
  window.getComputedStyle = ((elt: Element, pseudoElt?: string | null) => {
    if (!(elt instanceof Element)) {
      return originalGetComputedStyle(document.documentElement, pseudoElt ?? undefined)
    }
    return originalGetComputedStyle(elt, pseudoElt ?? undefined)
  }) as typeof window.getComputedStyle

  const deepLinkEvent = "opencode:deep-link"

  const emitDeepLinks = (urls: string[]) => {
    if (urls.length === 0) return
    window.__OPENCODE__ ??= {}
    const pending = window.__OPENCODE__.deepLinks ?? []
    window.__OPENCODE__.deepLinks = [...pending, ...urls]
    window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
  }

  const listenForDeepLinks = () => {
    const start = window.__OPENCODE__?.deepLinks ?? []
    if (start.length) emitDeepLinks(start)
    return desktopApi().onDeepLink((urls) => emitDeepLinks(urls))
  }

  const createPlatform = (): Platform => {
    const wslHome = async () => {
      if (os !== "windows" || !window.__OPENCODE__?.wsl) return undefined
      return desktopApi()
        .wslPath("~", "windows")
        .catch(() => undefined)
    }

    const handleWslPicker = async <T extends string | string[]>(result: T | null): Promise<T | null> => {
      if (!result || !window.__OPENCODE__?.wsl) return result
      if (Array.isArray(result)) {
        const next = await Promise.all(
          result.map((path) =>
            desktopApi()
              .wslPath(path, "linux")
              .catch(() => path),
          ),
        )
        return next as T
      }
      return desktopApi()
        .wslPath(result, "linux")
        .catch(() => result) as Promise<T>
    }

    const storage = (() => {
      const cache = new Map<string, AsyncStorage>()

      const createStorage = (name: string) => {
        const api: AsyncStorage = {
          getItem: (key: string) => desktopApi().storeGet(name, key),
          setItem: (key: string, value: string) => desktopApi().storeSet(name, key, value),
          removeItem: (key: string) => desktopApi().storeDelete(name, key),
          clear: () => desktopApi().storeClear(name),
          key: async (index: number) => (await desktopApi().storeKeys(name))[index],
          getLength: () => desktopApi().storeLength(name),
          get length() {
            return api.getLength()
          },
        }
        return api
      }

      return (name = "default.dat") => {
        const cached = cache.get(name)
        if (cached) return cached
        const api = createStorage(name)
        cache.set(name, api)
        return api
      }
    })()

    return {
      platform: "desktop",
      os,
      version: pkg.version,
      processDiagnostics: desktopApi().processDiagnostics,

      async openDirectoryPickerDialog(opts) {
        const defaultPath = await wslHome()
        const result = await desktopApi().openDirectoryPicker({
          multiple: opts?.multiple ?? false,
          title: opts?.title ?? t("desktop.dialog.chooseFolder"),
          defaultPath,
        })
        return handleWslPicker(result)
      },

      async openFilePickerDialog(opts) {
        const result = await desktopApi().openFilePicker({
          multiple: opts?.multiple ?? false,
          title: opts?.title ?? t("desktop.dialog.chooseFile"),
        })
        return handleWslPicker(result)
      },

      async saveFilePickerDialog(opts) {
        const result = await desktopApi().saveFilePicker({
          title: opts?.title ?? t("desktop.dialog.saveFile"),
          defaultPath: opts?.defaultPath,
        })
        return handleWslPicker(result)
      },

      openLink(url: string) {
        desktopApi().openLink(url)
      },

      async openPath(path: string, app?: string) {
        if (os === "windows") {
          const nextApp = app
            ? await desktopApi()
                .resolveAppPath(app)
                .catch(() => null)
            : null
          const nextPath = await (async () => {
            if (window.__OPENCODE__?.wsl) {
              const converted = await desktopApi()
                .wslPath(path, "windows")
                .catch(() => null)
              if (converted) return converted
            }
            return path
          })()
          return desktopApi().openPath(nextPath, nextApp ?? undefined)
        }
        return desktopApi().openPath(path, app)
      },

      async showItemInFolder(path: string) {
        return desktopApi().showItemInFolder(path)
      },

      restart: restartApp,

      quit: async () => {
        desktopApi().quit()
      },

      back() {
        window.history.back()
      },

      forward() {
        window.history.forward()
      },

      storage,

      checkUpdate: async () => {
        if (!UPDATER_ENABLED) return { updateAvailable: false }
        return desktopApi().checkUpdate()
      },

      updateAndRestart: async () => {
        if (!UPDATER_ENABLED) return
        await desktopApi().installUpdate()
      },

      getStartAtLogin: () => desktopApi().getStartAtLogin(),
      setStartAtLogin: (enabled) => desktopApi().setStartAtLogin(enabled),

      notify: async (title, description, href) => {
        const focused = await desktopApi()
          .getWindowFocused()
          .catch(() => document.hasFocus())
        if (focused) return

        const notification = new Notification(title, {
          body: description ?? "",
          icon: new URL("./favicon-96x96-v3.png", window.location.href).toString(),
        })
        notification.onclick = () => {
          void desktopApi().showWindow()
          void desktopApi().setWindowFocus()
          handleNotificationClick(href)
          notification.close()
        }
      },

      fetch: (input, init) => (input instanceof Request ? fetch(input) : fetch(input, init)),

      getWslEnabled: async () => {
        const next = await desktopApi()
          .getWslConfig()
          .catch(() => null)
        if (next) return next.enabled
        return window.__OPENCODE__?.wsl ?? false
      },

      setWslEnabled: async (enabled) => {
        await desktopApi().setWslConfig({ enabled })
      },

      getDefaultServer: async () => {
        const next = await desktopApi()
          .getDefaultServer()
          .catch(() => null)
        return next ? ServerConnection.Key.make(next) : null
      },

      setDefaultServer: async (url) => {
        await desktopApi().setDefaultServer(url)
      },

      getDisplayBackend: async () => {
        return desktopApi()
          .getDisplayBackend()
          .catch(() => null)
      },

      setDisplayBackend: async (backend) => {
        await desktopApi().setDisplayBackend(backend)
      },

      webviewZoom,

      checkAppExists: async (appName: string) => {
        return desktopApi().checkAppExists(appName)
      },

      async readClipboardImage() {
        const image = await desktopApi()
          .readClipboardImage()
          .catch(() => null)
        if (!image) return null
        const blob = new Blob([image.buffer], { type: "image/png" })
        return new File([blob], `pasted-image-${Date.now()}.png`, { type: "image/png" })
      },

      getAuthToken,
    }
  }

  let menuTrigger = null as null | ((id: string) => void)
  desktopApi().onMenuCommand((id) => {
    menuTrigger?.(id)
  })
  listenForDeepLinks()

  render(() => {
    const platform = createPlatform()

    const handleClick = (event: MouseEvent) => {
      const link = (event.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
      if (!link?.href) return
      event.preventDefault()
      platform.openLink(link.href)
    }

    onMount(() => {
      document.addEventListener("click", handleClick)
      onCleanup(() => {
        document.removeEventListener("click", handleClick)
      })
    })

    return (
      <ConfigProvider config={config}>
        <PlatformProvider value={platform}>
          <AppBaseProviders>
            <ServerGate>
              {(data) => {
                configureApiRuntime({
                  baseUrl: data().url,
                  password: data().password ?? undefined,
                })

                const http = {
                  url: data().url,
                  password: data().password ?? undefined,
                }
                const server: ServerConnection.Any = { type: "sidecar", variant: "base", http }

                const Inner = () => {
                  const cmd = useCommand()
                  menuTrigger = (id) => cmd.trigger(id)
                  return null
                }

                const ThemeSync = () => {
                  const theme = useTheme()
                  createEffect(() => {
                    desktopApi().setNativeTheme(theme.colorScheme())
                  })
                  return null
                }

                return (
                  <AppInterface defaultServer={ServerConnection.key(server)} servers={[server]} router={MemoryRouter}>
                    <Inner />
                    <ThemeSync />
                  </AppInterface>
                )
              }}
            </ServerGate>
          </AppBaseProviders>
        </PlatformProvider>
      </ConfigProvider>
    )
  }, root!)
}

function MissingElectronShell() {
  return (
    <div class="h-screen w-screen flex flex-col items-center justify-center bg-background-base px-6 text-center">
      <div class="max-w-md rounded-lg border border-border-weak-base bg-surface-base p-5">
        <div class="text-16-semibold text-text-base">Open Claxedo from the desktop app</div>
        <div class="mt-2 text-13-regular text-text-weaker">
          This renderer needs Electron preload APIs. The browser tab can show the Vite server, but it cannot run the
          desktop shell by itself.
        </div>
      </div>
    </div>
  )
}

function ServerGate(props: { children: (data: Accessor<ServerReadyData>) => JSX.Element }) {
  const [serverData] = createResource(() => desktopApi().awaitInitialization(() => undefined))

  const errorMessage = () => {
    const error = serverData.error
    if (!error) return t("error.chain.unknown")
    if (typeof error === "string") return error
    if (error instanceof Error) return error.message
    return String(error)
  }

  return (
    <Show
      when={serverData.state === "errored"}
      fallback={
        <Show
          when={serverData.state !== "pending" && serverData()}
          fallback={
            <div class="h-screen w-screen flex flex-col items-center justify-center bg-background-base">
              <ClaxedoSplash class="w-16 h-20 opacity-50 animate-pulse" />
            </div>
          }
        >
          {(data) => props.children(data)}
        </Show>
      }
    >
      <div class="h-screen w-screen flex flex-col items-center justify-center bg-background-base gap-4 px-6">
        <div class="text-16-semibold">{t("desktop.error.serverStartFailed.title")}</div>
        <div class="text-12-regular opacity-70 text-center max-w-xl">
          {t("desktop.error.serverStartFailed.description")}
        </div>
        <div class="w-full max-w-3xl rounded border border-border-base bg-background-base overflow-auto max-h-64">
          <pre class="p-3 whitespace-pre-wrap break-words text-11-regular">{errorMessage()}</pre>
        </div>
        <button
          class="px-3 py-2 rounded bg-button-primary-base text-text-invert-strong"
          onClick={() => void restartApp()}
        >
          {t("error.page.action.restart")}
        </button>
      </div>
    </Show>
  )
}
