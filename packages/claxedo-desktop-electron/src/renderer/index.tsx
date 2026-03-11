// @refresh reload

import {
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  type Platform as AppPlatform,
  PlatformProvider,
  ServerConnection,
  useCommand,
} from "@opencode-ai/app"
import { ConfigProvider, getAuthToken, getDefaultConfig, initClaxedo } from "@opencode-ai/claxedo-app"
import { ClaxedoSplash } from "@claxedo/claxedo-ui/components/claxedo-logo"
import type { AsyncStorage } from "@solid-primitives/storage"
import { type Accessor, createResource, createSignal, type JSX, createEffect, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter } from "@solidjs/router"

import { useTheme } from "@opencode-ai/ui/theme"
import { initPostHog, capture as phCapture } from "@claxedo/opencode-patches/observability/posthog"

import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { UPDATER_ENABLED } from "./updater"
import { webviewZoom } from "./webview-zoom"
import "./styles.css"
import type { ServerReadyData } from "../preload/types"

type Platform = AppPlatform & {
  getAuthToken?(): Promise<string | null>
}


const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

void initI18n()

// ── Error handling ──

const encode = (reason: unknown) => {
  if (reason instanceof Error) return { name: reason.name, message: reason.message, stack: reason.stack ?? null }
  if (typeof reason === "string") return { message: reason }
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
      document.body.appendChild(elt)
      return elt
    })()

  const text = (() => {
    try {
      return `${label}\n` + JSON.stringify(payload, null, 2)
    } catch {
      return `${label}\n` + String(payload)
    }
  })()
  host.textContent = text
}

window.addEventListener(
  "error",
  (event) => {
    const payload = {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: encode(event.error),
    }
    console.error("[desktop] window.error", payload)
    if (import.meta.env.DEV) showFatal("window.error", payload)
  },
  true,
)

window.addEventListener(
  "unhandledrejection",
  (event) => {
    const payload = encode(event.reason)
    console.error("[desktop] unhandledrejection", payload)
    if (import.meta.env.DEV) showFatal("unhandledrejection", payload)
    event.preventDefault()
  },
  true,
)

// ── Initialize Claxedo ──

const config = getDefaultConfig()
initClaxedo(config)

// Initialize PostHog analytics (no-ops if VITE_POSTHOG_KEY not set)
initPostHog()

const os = (() => {
  const ua = navigator.userAgent
  if (ua.includes("Mac")) return "macos" as const
  if (ua.includes("Windows")) return "windows" as const
  if (ua.includes("Linux")) return "linux" as const
  return undefined
})()

phCapture("app_launched", { platform: "desktop", version: pkg.version, os })

// Floating UI can call getComputedStyle with non-elements
const originalGetComputedStyle = window.getComputedStyle
window.getComputedStyle = ((elt: Element, pseudoElt?: string | null) => {
  if (!(elt instanceof Element)) {
    return originalGetComputedStyle(document.documentElement, pseudoElt ?? undefined)
  }
  return originalGetComputedStyle(elt, pseudoElt ?? undefined)
}) as typeof window.getComputedStyle

// ── Deep links ──

const deepLinkEvent = "opencode:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  const startUrls = window.__OPENCODE__?.deepLinks ?? []
  if (startUrls.length) emitDeepLinks(startUrls)
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

// ── Platform ──

const createPlatform = (password: () => string | null): Platform => {
  const wslHome = async () => {
    if (os !== "windows" || !window.__OPENCODE__?.wsl) return undefined
    return window.api.wslPath("~", "windows").catch(() => undefined)
  }

  const handleWslPicker = async <T extends string | string[]>(result: T | null): Promise<T | null> => {
    if (!result || !window.__OPENCODE__?.wsl) return result
    if (Array.isArray(result)) {
      return Promise.all(result.map((path) => window.api.wslPath(path, "linux").catch(() => path))) as any
    }
    return window.api.wslPath(result, "linux").catch(() => result) as any
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
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

    async openDirectoryPickerDialog(opts) {
      const defaultPath = await wslHome()
      const result = await window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
        defaultPath,
      })
      return await handleWslPicker(result)
    },

    async openFilePickerDialog(opts) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
      })
      return handleWslPicker(result)
    },

    async saveFilePickerDialog(opts) {
      const result = await window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      return handleWslPicker(result)
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        const resolvedPath = await (async () => {
          if (window.__OPENCODE__?.wsl) {
            const converted = await window.api.wslPath(path, "windows").catch(() => null)
            if (converted) return converted
          }
          return path
        })()
        return window.api.openPath(resolvedPath, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
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
      return window.api.checkUpdate()
    },

    update: async () => {
      if (!UPDATER_ENABLED) return
      await window.api.installUpdate()
    },

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "/favicon-96x96-v3.png",
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        handleNotificationClick(href)
        notification.close()
      }
    },

    fetch: (input, init) => {
      const pw = password()

      const addHeader = (headers: Headers, password: string) => {
        if (headers.has("Authorization")) return
        headers.set("Authorization", `Basic ${btoa(`opencode:${password}`)}`)
      }

      if (input instanceof Request) {
        if (pw) addHeader(input.headers, pw)
        return fetch(input)
      } else {
        const headers = new Headers(init?.headers)
        if (pw) addHeader(headers, pw)
        return fetch(input, {
          ...(init as any),
          headers,
        })
      }
    },

    getWslEnabled: async () => {
      const next = await window.api.getWslConfig().catch(() => null)
      if (next) return next.enabled
      return window.__OPENCODE__!.wsl ?? false
    },

    setWslEnabled: async (enabled) => {
      await window.api.setWslConfig({ enabled })
    },

    getDefaultServerUrl: async () => {
      return window.api.getDefaultServerUrl().catch(() => null)
    },

    setDefaultServerUrl: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, { type: "image/png" })
    },

    getAuthToken,
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

render(() => {
  const [serverPassword, setServerPassword] = createSignal<string | null>(null)
  const platform = createPlatform(() => serverPassword())

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
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
              setServerPassword(data().password)
              window.__OPENCODE__ ??= {}
              window.__OPENCODE__.serverPassword = data().password ?? undefined
              window.__OPENCODE__.serverUrl = data().url

              const http = {
                url: data().url,
                password: data().password ?? undefined,
              }
              const server: ServerConnection.Any = { type: "sidecar", variant: "base", http }

              function Inner() {
                const cmd = useCommand()
                menuTrigger = (id) => cmd.trigger(id)
                return null
              }

              function ThemeSync() {
                const theme = useTheme()
                createEffect(() => {
                  window.api.setNativeTheme(theme.colorScheme())
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

// Gate component that waits for the server to be ready
function ServerGate(props: { children: (data: Accessor<ServerReadyData>) => JSX.Element }) {
  const [serverData] = createResource(() => window.api.awaitInitialization(() => undefined))

  const errorMessage = () => {
    const error = serverData.error
    if (!error) return t("error.chain.unknown")
    if (typeof error === "string") return error
    if (error instanceof Error) return error.message
    return String(error)
  }

  const restartApp = async () => {
    await window.api.killSidecar().catch(() => undefined)
    window.api.relaunch()
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
        <div class="w-full max-w-3xl rounded border border-border bg-background-base overflow-auto max-h-64">
          <pre class="p-3 whitespace-pre-wrap break-words text-11-regular">{errorMessage()}</pre>
        </div>
        <button class="px-3 py-2 rounded bg-primary text-primary-foreground" onClick={() => void restartApp()}>
          {t("error.page.action.restart")}
        </button>
      </div>
    </Show>
  )
}
