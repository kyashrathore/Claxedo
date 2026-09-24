import { createEffect, createRoot, on } from "solid-js"
import type {
  CommandDefinition,
  MentionProvider,
  OverlayDefinition,
  PageDefinition,
  PluginApi,
  SessionRef,
  SettingsSection,
} from "@claxedo/plugin-api"
import type { FrameContext, FrameResponse, HostCall, Registration } from "../protocol"
import type { FrameLink } from "./link"

export class FrameUnsupportedError extends Error {
  constructor(member: string) {
    super(`${member} is not available to a plugin running in the browser's sandboxed frame`)
    this.name = "FrameUnsupportedError"
  }
}

export type FrameEntries = {
  readonly pages: Map<string, PageDefinition>
  readonly settings: Map<string, SettingsSection>
  readonly overlays: Map<string, OverlayDefinition>
  readonly commands: Map<string, CommandDefinition>
  readonly mentions: Map<string, MentionProvider>
}

export type FrameScope = {
  readonly link: FrameLink
  readonly context: FrameContext
  readonly entries: FrameEntries
  readonly forward: boolean
  readonly signal: AbortSignal
}

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304])

function keep<Value>(scope: FrameScope, map: Map<string, Value>, id: string, value: Value, registration: Registration): () => void {
  map.set(id, value)
  const unregister = scope.forward ? scope.link.register(registration) : undefined
  return () => {
    map.delete(id)
    unregister?.()
  }
}

function fireAndReport(scope: FrameScope, call: HostCall): void {
  scope.link.call(call).catch((error: unknown) => console.error(`Plugin ${scope.context.pluginId}: ${call.method} failed`, error))
}

function requestInit(init: RequestInit | undefined) {
  if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") throw new FrameUnsupportedError("a request body other than text")
  return { method: init?.method, headers: [...new Headers(init?.headers).entries()], body: init?.body ?? undefined }
}

function response(answer: FrameResponse): Response {
  const body = NULL_BODY_STATUSES.has(answer.status) ? null : answer.body
  return new Response(body, { status: answer.status, statusText: answer.statusText, headers: answer.headers.map(([name, value]): [string, string] => [name, value]) })
}

function fill(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (!params) return template
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))
}

function regionApi(scope: FrameScope): Pick<PluginApi, "sidebar" | "pages" | "panes" | "settings" | "overlays"> {
  const { entries } = scope
  const register = (registration: Registration) => (scope.forward ? scope.link.register(registration) : () => undefined)
  return {
    sidebar: { item: (item) => register({ kind: "sidebar", id: item.id, label: item.label, pageId: item.pageId, icon: item.icon, order: item.order }) },
    pages: {
      register: (page) => keep(scope, entries.pages, page.id, page, { kind: "page", id: page.id, path: page.path, title: page.title }),
      open: (pageId, params) => fireAndReport(scope, { method: "pages.open", pageId, params }),
    },
    panes: {
      register: () => {
        throw new FrameUnsupportedError("panes.register")
      },
      open: () => {
        throw new FrameUnsupportedError("panes.open")
      },
    },
    settings: {
      section: (section) =>
        keep(scope, entries.settings, section.id, section, { kind: "settings", id: section.id, title: section.title, icon: section.icon, order: section.order }),
    },
    overlays: {
      register: (overlay) => keep(scope, entries.overlays, overlay.id, overlay, { kind: "overlay", id: overlay.id, keybinding: overlay.keybinding }),
      open: (overlayId) => fireAndReport(scope, { method: "overlays.open", overlayId }),
      close: (overlayId) => fireAndReport(scope, { method: "overlays.close", overlayId }),
    },
  }
}

function actionApi(scope: FrameScope): Pick<PluginApi, "commands" | "mentions" | "workbench" | "themes" | "icons"> {
  const { entries, link } = scope
  return {
    commands: {
      register: (command) =>
        keep(scope, entries.commands, command.id, command, { kind: "command", id: command.id, title: command.title, keybinding: command.keybinding, category: command.category }),
      run: async (commandId) => {
        await link.call({ method: "commands.run", commandId })
      },
    },
    mentions: { register: (provider) => keep(scope, entries.mentions, provider.id, provider, { kind: "mention", id: provider.id, label: provider.label }) },
    workbench: {
      tabs: () => link.mirror.tabs,
      activate: (tabId) => fireAndReport(scope, { method: "workbench.activate", tabId }),
      close: (tabId) => fireAndReport(scope, { method: "workbench.close", tabId }),
      move: (tabId, index) => fireAndReport(scope, { method: "workbench.move", tabId, index }),
      onChanged: (listener) =>
        createRoot((dispose) => {
          createEffect(on(() => link.mirror.tabs, (tabs) => listener(tabs), { defer: true }))
          return dispose
        }),
    },
    themes: { register: (theme) => (scope.forward ? link.register({ kind: "theme", theme }) : () => undefined) },
    icons: {
      registerSkin: () => {
        throw new FrameUnsupportedError("icons.registerSkin")
      },
    },
  }
}

function dataApi(scope: FrameScope): Pick<PluginApi, "sessions" | "projects" | "server" | "context" | "ui" | "i18n"> {
  const { link, context } = scope
  return {
    sessions: {
      create: async (input) => (await link.call({ method: "sessions.create", input })) as SessionRef,
      status: (ref) => link.mirror.statuses[ref.sessionId] ?? "idle",
      open: (ref) => fireAndReport(scope, { method: "sessions.open", ref }),
    },
    projects: { list: () => link.mirror.projects, currentId: () => link.mirror.currentProjectId },
    server: {
      fetch: async (path, init) => response((await link.call({ method: "server.fetch", path, init: requestInit(init) })) as FrameResponse),
      operation: async <Result>(name: string, input?: unknown) => (await link.call({ method: "server.operation", name, input })) as Result,
    },
    context: {
      ...context,
      get locale() {
        return link.mirror.locale
      },
      currentProjectId: () => link.mirror.currentProjectId,
      currentSession: () => link.mirror.currentSession,
      signal: scope.signal,
    },
    ui: {
      toast: (toast) => fireAndReport(scope, { method: "ui.toast", toast }),
      confirm: async (confirmation) => (await link.call({ method: "ui.confirm", confirmation })) === true,
    },
    i18n: { t: fill },
  }
}

export function createFrameApi(scope: FrameScope): PluginApi {
  return { ...regionApi(scope), ...actionApi(scope), ...dataApi(scope) }
}
