import { createStore, produce } from "solid-js/store"
import { batch, createContext, createEffect, createMemo, on, onCleanup, onMount, useContext, type Accessor, type ParentProps } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useServer } from "@/app/connection/server"
import { Project } from "@opencode-ai/sdk/v2"
import { Persist, persisted, removePersisted } from "@/platform/persistence/persist"
import { same } from "@/lib/same"
import { createScrollPersistence, type SessionScroll } from "@/app/providers/layout-scroll"
import { validProjectRef, validWorktree } from "@/platform/sync/worktree"
import {
  planProjectColorAssignment,
  projectCatalog,
  resolveSandboxRootActions,
  sidebarProjectsMissingFromApi,
  syncApiProjectsToSidebar,
} from "@/app/providers/layout-projects"
import { isUserHostedWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import { queryKeys } from "@/platform/query/keys"
import { queryClient } from "@/platform/query/query-client"
import { setProjectIcon, upsertProjectMeta } from "../../features/workspaces/data/query/project-meta"
import type { ProjectMeta } from "../../features/session/data/query/types"
import { useDirectorySessionCacheActions } from "../../features/session/data/sync/directory-session-cache"
import { useSessionInventoryActions } from "../../features/session/data/sync/session-inventory"
import { useGlobalShellReady } from "../integrations/sync/global-readiness"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]
const SERVER_SCOPED_PERSIST = import.meta.env.VITE_SERVER_SCOPED_PERSIST === "true"

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

type SessionTabs = {
  active?: string
  all: string[]
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
  pendingMessage?: string
  pendingMessageAt?: number
  todoCollapsed?: boolean
}

type TabHandoff = {
  dir: string
  id: string
  at: number
}

const PENDING_MESSAGE_TTL_MS = 5000

export type LocalProject = Partial<Project> & { worktree: string; expanded: boolean }

export type ReviewDiffStyle = "unified" | "split"

function isSignedWorkspaceDirectory(input: string | undefined) {
  return !!(input && sessionWorkspaceRuntimeRef({ directory: input })) || isUserHostedWorkspaceDirectory(input)
}

function createLayoutContextValue() {
    const globalSdk = useGlobalSDK()
    const globalReady = useGlobalShellReady()
    const sessionInventoryActions = useSessionInventoryActions()
    const directorySessionCacheActions = useDirectorySessionCacheActions()
    const queryOptions = useQueryOptions()
    const projectsQuery = useQuery(() => queryOptions.projects())
    const server = useServer()
    const ensureDirectorySessionCache = (directory: string) => {
      void directorySessionCacheActions.ensure({
        directory,
      })
    }

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)

    const migrate = (value: unknown) => {
      if (!isRecord(value)) return value

      const sidebar = value.sidebar
      const migratedSidebar = (() => {
        if (!isRecord(sidebar)) return sidebar
        if (typeof sidebar.workspaces !== "boolean") return sidebar
        return {
          ...sidebar,
          workspaces: {},
          workspacesDefault: sidebar.workspaces,
        }
      })()

      const fileTree = value.fileTree
      const review = value.review
      const migratedFileTree = (() => {
        if (!isRecord(fileTree)) return fileTree
        if (fileTree.tab === "changes" || fileTree.tab === "all") return fileTree

        const width = typeof fileTree.width === "number" ? fileTree.width : 344
        return {
          ...fileTree,
          opened: true,
          width: width === 260 ? 344 : width,
          tab: "changes",
        }
      })()

      const migratedReview = (() => {
        if (!isRecord(review)) return review
        if (typeof review.panelOpened === "boolean") return review
        const opened = isRecord(fileTree) && typeof fileTree.opened === "boolean" ? fileTree.opened : true
        return { ...review, panelOpened: opened }
      })()

      if (migratedSidebar === sidebar && migratedFileTree === fileTree && migratedReview === review) return value
      return {
        ...value,
        sidebar: migratedSidebar,
        fileTree: migratedFileTree,
        review: migratedReview,
      }
    }

    const target = Persist.global("layout", ["layout.v6"])
    const [store, setStore, _, ready] = persisted(
      { ...target, migrate },
      createStore({
        sidebar: {
          opened: false,
          width: 344,
          workspaces: {} as Record<string, boolean>,
          workspacesDefault: false,
        },
        terminal: {
          height: 280,
          opened: false,
        },
        review: {
          diffStyle: "split" as ReviewDiffStyle,
          panelOpened: true,
        },
        fileTree: {
          opened: true,
          width: 344,
          tab: "changes" as "changes" | "all",
        },
        session: {
          width: 600,
          collapsed: false,
          panelMode: 0 as number, // 0-5 cycle for panel visibility
        },
        mobileSidebar: {
          opened: false,
        },
        sessionTabs: {} as Record<string, SessionTabs>,
        sessionView: {} as Record<string, SessionView>,
        handoff: {
          tabs: undefined as TabHandoff | undefined,
        },
      }),
    )

    const MAX_SESSION_KEYS = 50
    const meta = { active: undefined as string | undefined, pruned: false }
    const used = new Map<string, number>()

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
      { key: "file-view", legacy: "file", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const parts = key.split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = SERVER_SCOPED_PERSIST
            ? Persist.serverScoped(server.url, dir, session, entry.key)
            : Persist.scoped(dir, session, entry.key)
          void removePersisted(target)

          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          void removePersisted({ key: legacyKey })
        }
      }
    }

    function prune(keep?: string) {
      if (!keep) return

      const keys = new Set<string>()
      for (const key of Object.keys(store.sessionView)) keys.add(key)
      for (const key of Object.keys(store.sessionTabs)) keys.add(key)
      if (keys.size <= MAX_SESSION_KEYS) return

      const score = (key: string) => {
        if (key === keep) return Number.MAX_SAFE_INTEGER
        return used.get(key) ?? 0
      }

      const ordered = Array.from(keys).sort((a, b) => score(b) - score(a))
      const drop = ordered.slice(MAX_SESSION_KEYS)
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
            delete draft.sessionTabs[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)

      for (const key of drop) {
        used.delete(key)
      }
    }

    function touch(sessionKey: string) {
      meta.active = sessionKey
      used.set(sessionKey, Date.now())

      if (!ready()) return
      if (meta.pruned) return

      meta.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = meta.active ?? sessionKey
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...(prev ?? {}), ...next }))
        prune(keep)
      },
    })

    createEffect(() => {
      if (!ready()) return
      if (meta.pruned) return
      const active = meta.active
      if (!active) return
      meta.pruned = true
      prune(active)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      window.addEventListener("pagehide", flush)
      document.addEventListener("visibilitychange", handleVisibility)

      onCleanup(() => {
        window.removeEventListener("pagehide", flush)
        document.removeEventListener("visibilitychange", handleVisibility)
        scroll.dispose()
      })
    })

    const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})
    const colorRequested = new Map<string, AvatarColorKey>()
    const syncedProjects = () => projectsQuery.data ?? []
    const sidebarProjects = () => server.projects.list() ?? []

    function pickAvailableColor(used: Set<string>): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: { worktree: string; expanded: boolean }, meta?: Project) {
      const metadata = meta ?? syncedProjects().find((x) => x.worktree === project.worktree)
      const local = queryClient.getQueryData<ProjectMeta>(queryKeys.directory.projectMeta(project.worktree))
      const localIcon = queryClient.getQueryData<string | undefined>(queryKeys.directory.icon(project.worktree))
      const localOverride =
        local?.name !== undefined ||
        local?.commands?.start !== undefined ||
        local?.icon?.override !== undefined ||
        local?.icon?.color !== undefined

      const base = {
        ...(metadata ?? {}),
        ...project,
        icon: {
          url: metadata?.icon?.url,
          override: metadata?.icon?.override ?? local?.icon?.override ?? localIcon,
          color: metadata?.icon?.color,
        },
      }

      const isGlobal = metadata?.id === "global" || (metadata?.id === undefined && localOverride)
      if (!isGlobal) return base

      return {
        ...base,
        id: base.id ?? "global",
        name: local?.name,
        commands: local?.commands,
        icon: {
          url: base.icon?.url,
          override: local?.icon?.override,
          color: local?.icon?.color,
        },
      }
    }

    const catalog = createMemo(() =>
      projectCatalog({
        api: syncedProjects(),
        current: sidebarProjects(),
        closed: server.projects.isClosed,
        valid: validProjectRef,
      }))

    const rootFor = (directory: string) => catalog().rootFor(directory)

    // Effect 1: Sandbox → parent resolution (tracks server.projects.list())
    createEffect(() => {
      const actions = resolveSandboxRootActions({
        projects: sidebarProjects(),
        rootFor,
        valid: validWorktree,
      })
      batch(() => {
        for (const worktree of actions.removals) server.projects.remove(worktree)
        for (const root of actions.opens) server.projects.open(root)
        for (const root of actions.expands) server.projects.expand(root)
      })
    })

    // Effect 2: Remove sidebar projects that no longer exist in API.
    // Uses on() so the callback body is untracked — server.projects.list()
    // reads inside the body don't become dependencies. This prevents a race
    // where opening a project (mutating the sidebar) would immediately trigger
    // cleanup before the API confirms the project.
    createEffect(
      on(
        syncedProjects,
        (apiProjects) => {
          if (!server.isLocal()) return
          if (apiProjects.length === 0) return
          // server.projects.list() is read inside on() callback body → untracked
          const removals = sidebarProjectsMissingFromApi({
            sidebar: sidebarProjects(),
            api: apiProjects,
          })
          batch(() => {
            for (const worktree of removals) server.projects.remove(worktree)
          })
        },
      ),
    )

    const enriched = createMemo(() => {
      const meta = catalog().meta
      return (catalog().list ?? [])
        .filter((project) => !!project?.worktree)
        .map((project) => enrich(project, meta.get(project.worktree)))
    })
    const list = createMemo(() => {
      const projects = enriched() ?? []
      return projects.map((project) => {
        const color = project.icon?.color ?? colors[project.worktree]
        if (!color) return project
        const icon = project.icon ? { ...project.icon, color } : { color }
        return { ...project, icon }
      })
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      for (const project of projects) {
        if (!project.id) continue
        if (project.id === "global") continue
        setProjectIcon(project.worktree, project.icon?.override)
      }
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      const plan = planProjectColorAssignment({
        projects,
        colors,
        colorRequested,
        pick: pickAvailableColor,
        isSigned: isSignedWorkspaceDirectory,
      })

      for (const { worktree, color } of plan.assignments) setColors(worktree, color)
      for (const { worktree, color } of plan.metaUpserts) upsertProjectMeta(worktree, { icon: { color } })
      for (const { worktree, id, color } of plan.remoteUpdates) {
        void globalSdk.client.project
          .update({ projectID: id, directory: worktree, icon: { color } })
          .catch(() => {
            if (colorRequested.get(worktree) === color) colorRequested.delete(worktree)
          })
      }
    })

    onMount(() => {
      void sessionInventoryActions.load()
    })

    // Sync API projects to sidebar - ensures projects from server appear in sidebar
    createEffect(() => {
      if (!globalReady()) return
      if (server.isLocal()) return
      const apiProjects = syncedProjects()
      if (!apiProjects || apiProjects.length === 0) return

      const next = syncApiProjectsToSidebar({
        api: apiProjects,
        sidebar: sidebarProjects().map((p) => p.worktree),
        isClosed: server.projects.isClosed,
        valid: validWorktree,
      })
      if (!next) return

      server.projects.sync(next)
      // New workspaces bootstrap on-demand when user navigates to them
    })

    return {
      ready,
      handoff: {
        tabs: createMemo(() => store.handoff?.tabs),
        setTabs(dir: string, id: string) {
          setStore("handoff", "tabs", { dir, id, at: Date.now() })
        },
        clearTabs() {
          if (!store.handoff?.tabs) return
          setStore("handoff", "tabs", undefined)
        },
      },
      projects: {
        list,
        open(directory: string) {
          const root = rootFor(directory)
          if (!validWorktree(root)) return
          if (!catalog().meta.has(root)) return
          ensureDirectorySessionCache(root)
          if (!server.isLocal()) return
          if (sidebarProjects().some((x) => x.worktree === root)) return
          server.projects.open(root)
        },
        close(directory: string) {
          if (!server.isLocal()) return
          server.projects.close(directory)
        },
        isClosed(directory: string) {
          if (!server.isLocal()) return false
          return server.projects.isClosed(directory)
        },
        remove(directory: string) {
          server.projects.remove(directory)
        },
        expand(directory: string) {
          server.projects.expand(directory)
        },
        collapse(directory: string) {
          server.projects.collapse(directory)
        },
        toggle(directory: string) {
          const project = sidebarProjects().find((p) => p.worktree === directory)
          if (!project) return
          if (project.expanded) {
            server.projects.collapse(directory)
          } else {
            server.projects.expand(directory)
          }
        },
        move(directory: string, toIndex: number) {
          server.projects.move(directory, toIndex)
        },
      },
      sidebar: {
        opened: createMemo(() => store.sidebar.opened),
        open() {
          setStore("sidebar", "opened", true)
        },
        close() {
          setStore("sidebar", "opened", false)
        },
        toggle() {
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
        workspaces(directory: string) {
          return () => store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
        },
        setWorkspaces(directory: string, value: boolean) {
          setStore("sidebar", "workspaces", directory, value)
        },
        toggleWorkspaces(directory: string) {
          const current = store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
          setStore("sidebar", "workspaces", directory, !current)
        },
      },
      terminal: {
        height: createMemo(() => store.terminal.height),
        resize(height: number) {
          setStore("terminal", "height", height)
        },
      },
      review: {
        diffStyle: createMemo(() => store.review?.diffStyle ?? "split"),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { diffStyle })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
        panelOpened: createMemo(() => store.review?.panelOpened ?? true),
        togglePanel() {
          const current = store.review?.panelOpened ?? true
          if (!store.review) {
            setStore("review", { diffStyle: "split" as ReviewDiffStyle, panelOpened: !current })
            return
          }
          setStore("review", "panelOpened", !current)
        },
      },
      fileTree: {
        opened: createMemo(() => store.fileTree?.opened ?? true),
        width: createMemo(() => store.fileTree?.width ?? 344),
        tab: createMemo(() => store.fileTree?.tab ?? "changes"),
        setTab(tab: "changes" | "all") {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: 344, tab })
            return
          }
          setStore("fileTree", "tab", tab)
        },
        open() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: 344, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", true)
        },
        close() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: false, width: 344, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", false)
        },
        toggle() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: 344, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", (x) => !x)
        },
        resize(width: number) {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width, tab: "changes" })
            return
          }
          setStore("fileTree", "width", width)
        },
      },
      session: {
        width: createMemo(() => store.session?.width ?? 600),
        collapsed: createMemo(() => store.session?.collapsed ?? false),
        /**
         * Panel mode for visibility states:
         * 0: All visible (Messages + Review + Files)
         * 5: Messages collapsed (Review + Files)
         */
        panelMode: createMemo(() => store.session?.panelMode ?? 0),
        resize(width: number) {
          if (!store.session) {
            setStore("session", { width, collapsed: false, panelMode: 0 })
            return
          }
          setStore("session", "width", width)
        },
        collapse() {
          if (!store.session) {
            setStore("session", { width: 600, collapsed: true, panelMode: 0 })
            return
          }
          setStore("session", "collapsed", true)
        },
        expand() {
          if (!store.session) {
            setStore("session", { width: 600, collapsed: false, panelMode: 0 })
            return
          }
          setStore("session", "collapsed", false)
        },
        toggle() {
          if (!store.session) {
            setStore("session", { width: 600, collapsed: true, panelMode: 0 })
            return
          }
          setStore("session", "collapsed", (x) => !x)
        },
        // Set panel mode directly
        setPanelMode(mode: number) {
          if (!store.session) {
            setStore("session", { width: 600, collapsed: false, panelMode: mode })
            return
          }
          setStore("session", "panelMode", mode)
        },
      },
      mobileSidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      pendingMessage: {
        set(sessionKey: string, messageID: string) {
          const at = Date.now()
          touch(sessionKey)
          const current = store.sessionView[sessionKey]
          if (!current) {
            setStore("sessionView", sessionKey, {
              scroll: {},
              pendingMessage: messageID,
              pendingMessageAt: at,
            })
            prune(meta.active ?? sessionKey)
            return
          }

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              draft.pendingMessage = messageID
              draft.pendingMessageAt = at
            }),
          )
        },
        consume(sessionKey: string) {
          const current = store.sessionView[sessionKey]
          const message = current?.pendingMessage
          const at = current?.pendingMessageAt
          if (!message || !at) return

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              delete draft.pendingMessage
              delete draft.pendingMessageAt
            }),
          )

          if (Date.now() - at > PENDING_MESSAGE_TTL_MS) return
          return message
        },
      },
      view(sessionKey: string | Accessor<string>) {
        const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey

        touch(key())
        scroll.seed(key())

        createEffect(
          on(
            key,
            (value) => {
              touch(value)
              scroll.seed(value)
            },
            { defer: true },
          ),
        )

        const s = createMemo(() => store.sessionView[key()] ?? { scroll: {} })
        const terminalOpened = createMemo(() => store.terminal?.opened ?? false)

        function setTerminalOpened(next: boolean) {
          const current = store.terminal
          if (!current) {
            setStore("terminal", { height: 280, opened: next })
            return
          }

          const value = current.opened ?? false
          if (value === next) return
          setStore("terminal", "opened", next)
        }

        const reviewPanelOpened = createMemo(() => store.review?.panelOpened ?? true)

        function setReviewPanelOpened(next: boolean) {
          // When opening panel, ensure session width is at least 640
          if (next && store.session && store.session.width < 640) {
            setStore("session", "width", 640)
          }
          const current = store.review
          if (!current) {
            setStore("review", { diffStyle: "split" as ReviewDiffStyle, panelOpened: next })
            return
          }

          const value = current.panelOpened ?? true
          if (value === next) return
          setStore("review", "panelOpened", next)
        }

        return {
          scroll(tab: string) {
            return scroll.scroll(key(), tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(key(), tab, pos)
          },
          todoCollapsed: {
            get: () => s().todoCollapsed ?? false,
            set(collapsed: boolean) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, { scroll: {}, todoCollapsed: collapsed })
                return
              }
              setStore("sessionView", session, "todoCollapsed", collapsed)
            },
          },
          terminal: {
            opened: terminalOpened,
            open() {
              setTerminalOpened(true)
            },
            close() {
              setTerminalOpened(false)
            },
            toggle() {
              setTerminalOpened(!terminalOpened())
            },
          },
          reviewPanel: {
            opened: reviewPanelOpened,
            open() {
              setReviewPanelOpened(true)
            },
            close() {
              setReviewPanelOpened(false)
            },
            toggle() {
              setReviewPanelOpened(!reviewPanelOpened())
            },
          },
          review: {
            open: createMemo(() => s().reviewOpen),
            setOpen(open: string[]) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: open,
                })
                return
              }

              if (same(current.reviewOpen, open)) return
              setStore("sessionView", session, "reviewOpen", open)
            },
          },
        }
      },
      tabs(sessionKey: string | Accessor<string>) {
        const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey

        touch(key())

        createEffect(
          on(
            key,
            (value) => {
              touch(value)
            },
            { defer: true },
          ),
        )

        const tabs = createMemo(() => store.sessionTabs[key()] ?? { all: [] })
        return {
          tabs,
          active: createMemo(() => (tabs().active === "review" ? undefined : tabs().active)),
          all: createMemo(() => tabs().all.filter((tab) => tab !== "review")),
          setActive(tab: string | undefined) {
            const session = key()
            if (tab === "review") return
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: [], active: tab })
            } else {
              setStore("sessionTabs", session, "active", tab)
            }
          },
          setAll(all: string[]) {
            const session = key()
            const next = all.filter((tab) => tab !== "review")
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: next, active: undefined })
            } else {
              setStore("sessionTabs", session, "all", next)
            }
          },
          async open(tab: string) {
            if (tab === "review") return
            const session = key()
            const current = store.sessionTabs[session] ?? { all: [] }

            if (tab === "context") {
              const all = [tab, ...current.all.filter((x) => x !== tab)]
              if (!store.sessionTabs[session]) {
                setStore("sessionTabs", session, { all, active: tab })
                return
              }
              setStore("sessionTabs", session, "all", all)
              setStore("sessionTabs", session, "active", tab)
              return
            }

            if (!current.all.includes(tab)) {
              if (!store.sessionTabs[session]) {
                setStore("sessionTabs", session, { all: [tab], active: tab })
                return
              }
              setStore("sessionTabs", session, "all", [...current.all, tab])
              setStore("sessionTabs", session, "active", tab)
              return
            }

            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: current.all, active: tab })
              return
            }
            setStore("sessionTabs", session, "active", tab)
          },
          close(tab: string) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return

            const all = current.all.filter((x) => x !== tab)
            batch(() => {
              setStore("sessionTabs", session, "all", all)
              if (current.active !== tab) return

              const index = current.all.findIndex((f) => f === tab)
              const next = all[index - 1] ?? all[0]
              setStore("sessionTabs", session, "active", next)
            })
          },
          move(tab: string, to: number) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return
            const index = current.all.findIndex((f) => f === tab)
            if (index === -1) return
            setStore(
              "sessionTabs",
              session,
              "all",
              produce((opened) => {
                opened.splice(to, 0, opened.splice(index, 1)[0])
              }),
            )
          },
        }
      },
    }
}

export const LayoutContext = createContext<ReturnType<typeof createLayoutContextValue>>()

export function useLayout() {
  const value = useContext(LayoutContext)
  if (!value) throw new Error("Layout context must be used within a context provider")
  return value
}

export function LayoutProvider(props: ParentProps) {
  return <LayoutContext.Provider value={createLayoutContextValue()}>{props.children}</LayoutContext.Provider>
}
