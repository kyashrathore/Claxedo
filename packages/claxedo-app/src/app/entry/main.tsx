/**
 * Cloud-specific entry point for Claxedo.
 *
 * This file initializes cloud extensions and renders the OpenCode app
 * with cloud functionality enabled.
 */

// @refresh reload
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app/entry/app"
import { PlatformProvider, type Platform } from "@claxedo/app"
import { initClaxedo, getDefaultConfig } from "./index"
import { getAuthToken } from "@/platform/auth/auth-client"
import { authFetch } from "@/platform/api/api"
import { initPostHog, capture as phCapture } from "@/platform/telemetry/analytics"
import { isDemoMode, isEmbedMode } from "@/platform/api/api"
import { ConfigProvider } from "../providers/config"
import { ClaxedoEventsProvider } from "../integrations/claxedo-events"
import { Persist, resetDemoPersisted, setPersisted } from "@/platform/persistence/persist"

// Initialize cloud extensions before rendering
const config = getDefaultConfig()
initClaxedo(config)

// Initialize PostHog analytics (no-ops if VITE_POSTHOG_KEY not set)
if (!isDemoMode()) {
  initPostHog()
  phCapture("app_launched", { platform: "web", version: "cloud" })
}

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Make sure there is an element with id='root' in your index.html",
  )
}

/**
 * Platform configuration for cloud/web mode.
 */
const platform: Platform = {
  platform: "web",
  version: "cloud",
  fetch: authFetch,
  getAuthToken,
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
          icon: "https://opencode.ai/favicon-96x96-v3.png",
        })
        notification.onclick = () => {
          window.focus()
          if (href) {
            window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
          notification.close()
        }
      })
      .catch(() => undefined)
  },
}

async function startApp() {
  if (import.meta.env.DEV) console.log("[claxedo:boot]", "start", window.location.href)
  // In demo mode, start MSW to mock server responses before rendering
  if (isDemoMode()) {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("opencode.demo.")) continue
      localStorage.removeItem(key)
    }
    resetDemoPersisted()

    // Pre-seed the server store so the demo project auto-opens
    const demoProject = "/home/demo/projects/my-app"
    const featureBranch = "/home/demo/projects/my-app-feature-auth"
    const dashboardProject = "/home/demo/projects/dashboard"
    const serverKey = window.location.origin
    const projects = [
      { worktree: demoProject, expanded: true },
      { worktree: featureBranch, expanded: true },
      { worktree: dashboardProject, expanded: true },
    ]
    const pageTabId = "tab-page-demo-001"
    const sessionTabId = "tab-ses-wt-001"
    const baseTabs = [
      {
        id: pageTabId,
        type: "page",
        directory: demoProject,
        title: "Project Architecture",
        pageId: "page_demo_001",
        closable: true,
      },
      {
        id: sessionTabId,
        type: "session",
        directory: demoProject,
        title: "Add Google OAuth provider",
        sessionId: "ses_demo_001",
        closable: true,
      },
      {
        id: "tab-ses-wt-002",
        type: "session",
        directory: featureBranch,
        title: "Implement refresh token rotation",
        sessionId: "ses_wt_002",
        closable: true,
      },
      {
        id: "tab-ses-p2-001",
        type: "session",
        directory: dashboardProject,
        title: "Build real-time chart component",
        sessionId: "ses_p2_001",
        closable: true,
      },
    ]
    const tabs = baseTabs
    const colors = {
      [demoProject]: "#3b82f6",
      [featureBranch]: "#a855f7",
      [dashboardProject]: "#22c55e",
    }
    setPersisted(Persist.global("server"), {
      list: [],
      projects: {
        [serverKey]: projects,
      },
      lastProject: { [serverKey]: demoProject },
      workspaceServer: {},
    })

    const tabContentIds = tabs.map((item) => item.id)
    const meta = Object.fromEntries(
      tabs.map((item) => [
        item.id,
        item.type === "page"
          ? {
              id: item.id,
              type: "page",
              scope: "directory",
              directory: item.directory,
              pageId: item.pageId,
              content: {
                type: "page",
                directory: item.directory,
                pageId: item.pageId,
                title: item.title,
              },
            }
          : {
                id: item.id,
                type: "session",
                scope: "directory",
                directory: item.directory,
                sessionId: item.sessionId,
                content: {
                  type: "session",
                  directory: item.directory,
                  sessionId: item.sessionId,
                  title: item.title,
                },
              },
      ]),
    )

    setPersisted(Persist.global("claxedo.state.v5"), {
      workbench: {
        panes: [{ id: "pane-demo", contentId: pageTabId }],
        split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane-demo" } },
        contentIds: tabContentIds,
        contentRecency: [...tabContentIds].reverse(),
        focusedPaneId: "pane-demo",
        layoutSnapshots: {},
      },
      meta,
      rail: { collapsed: true, hovered: false, pinned: false, locked: false },
      workspace: {
        paneWorktree: {
          "pane-demo": { default: demoProject, pinned: null },
        },
        recency: {},
        worktreeColor: colors,
      },
      workspacePanel: { open: false },
      terminal: { owner: {}, agentStatus: {}, agentSeen: {}, lifecycle: {} },
      processPane: {
        toggleVersion: 0,
        pendingOpen: false,
        targetDirectory: null,
        crashedWhileClosed: false,
        pendingAction: null,
      },
    })

    // Start MSW with a hard timeout so demo rendering is never blocked forever.
    // The dynamic import is gated behind __DEMO_ENABLED__ (a compile-time define)
    // so that non-web builds (desktop/electron) can tree-shake away the msw dependency.
    if (__DEMO_ENABLED__) {
      const mswReady = (async () => {
        const { startWorker } = await import("../demo/browser")
        await startWorker({ onUnhandledRequest: "warn", quiet: false })
      })()
      const timeout = new Promise<void>((r) => {
        setTimeout(() => {
          r()
        }, 4000)
      })
      await Promise.race([mswReady, timeout])
    }
  }

  // Render the standard app with cloud extensions active
  if (import.meta.env.DEV) console.log("[claxedo:boot]", "before-render", { hasRoot: root instanceof HTMLElement })
  render(
    () => (
      <ConfigProvider config={config}>
        <PlatformProvider value={platform}>
          <ClaxedoEventsProvider>
            <AppBaseProviders>
              <AppInterface />
            </AppBaseProviders>
          </ClaxedoEventsProvider>
        </PlatformProvider>
      </ConfigProvider>
    ),
    root!,
  )
  if (import.meta.env.DEV) console.log("[claxedo:boot]", "after-render", {
    rootChildren: root?.childElementCount ?? null,
  })
}

function renderStartupFailure(error: unknown) {
  if (!(root instanceof HTMLElement)) return
  const message = error instanceof Error && error.message ? error.message : "Unknown startup failure"
  root.replaceChildren()
  root.style.backgroundColor = "var(--background-base, #101010)"
  root.style.color = "var(--text-base, #a0a0a0)"
  root.style.minHeight = "100dvh"
  root.style.display = "grid"
  root.style.placeItems = "center"

  const panel = document.createElement("div")
  panel.style.maxWidth = "520px"
  panel.style.padding = "24px"
  panel.style.fontFamily = "var(--font-family-sans, system-ui, sans-serif)"
  panel.style.lineHeight = "1.5"

  const title = document.createElement("div")
  title.textContent = "Claxedo failed to start"
  title.style.color = "var(--text-strong, #f2f2f2)"
  title.style.fontSize = "14px"
  title.style.fontWeight = "600"

  const body = document.createElement("pre")
  body.textContent = message
  body.style.margin = "12px 0 0"
  body.style.whiteSpace = "pre-wrap"
  body.style.color = "var(--text-weak, #b8b8b8)"
  body.style.fontSize = "12px"

  panel.append(title, body)
  root.append(panel)
}

void startApp().catch((error) => {
  console.error("[claxedo:boot]", "failed", error)
  renderStartupFailure(error)
})
