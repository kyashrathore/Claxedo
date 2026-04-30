import { createEffect, createMemo, createResource, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Popover } from "@opencode-ai/ui/popover"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { normalizeServerUrl, ServerConnection } from "@/context/server"
import { usePlatform, useServer } from "@opencode-ai/claxedo-app"
import { useLanguage } from "@/context/language"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { showToast } from "@opencode-ai/ui/toast"
import { ServerRow } from "@/components/server/server-row"
import { useCheckServerHealth, type ServerHealth } from "@/utils/server-health"
import { createOpencodeClient, type McpStatus } from "@opencode-ai/sdk/v2/client"
import { getExtensions } from "@opencode-ai/app-shared"
import { queryClient } from "../../shared/query/query-client"
import { workspaceLspQuery, workspaceMcpQuery } from "../../shared/query/runtime"

export type StatusPopoverProps = {
  class?: string
  triggerClass?: string
  directory?: string
  placement?: "bottom-end" | "right-start" | "right" | "top-start" | "top-end"
  onOpenChange?: (open: boolean) => void
  children?: JSX.Element | ((state: { overallHealthy: boolean; serverHealthy: boolean | undefined }) => JSX.Element)
}

export function StatusPopover(props: StatusPopoverProps) {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const ext = getExtensions()
  const checkServerHealth = useCheckServerHealth()

  const directory = createMemo(() => props.directory)
  const isStatusOnly = () => ext.app.serverSelectorMode === "status-only"

  // Access child sync store if directory is active
  const syncStore = createMemo(() => {
    const dir = directory()
    if (!dir) return undefined
    return globalSync.child(dir)[0]
  })

  const [store, setStore] = createStore({
    status: {} as Record<string, ServerHealth | undefined>,
    loading: null as string | null,
    defaultServerUrl: undefined as string | undefined,
  })

  const directoryClient = createMemo(() => {
    const dir = directory()
    if (!dir) return
    return createOpencodeClient({
      baseUrl: globalSDK.url,
      fetch: platform.fetch,
      directory: dir,
      throwOnError: true,
    })
  })

  const mcpSource = createMemo(() => {
    const dir = directory()
    const client = directoryClient()
    if (!dir || !client) return
    return { directory: dir, client }
  })
  const [mcpStatus, { refetch: refetchMcpStatus }] = createResource(mcpSource, async (source) =>
    queryClient.fetchQuery(workspaceMcpQuery({
      baseUrl: globalSDK.url,
      directory: source.directory,
      client: source.client,
    })))

  const lspSource = createMemo(() => {
    const dir = directory()
    const client = directoryClient()
    if (!dir || !client) return
    return { directory: dir, client }
  })
  const [lspStatus, { refetch: refetchLspStatus }] = createResource(lspSource, async (source) =>
    queryClient.fetchQuery(workspaceLspQuery({
      baseUrl: globalSDK.url,
      directory: source.directory,
      client: source.client,
    })))

  // Convert typed server list to URL strings for our string-based UI
  const serverUrls = createMemo(() => server.list.map((s) => s.http.url))

  const servers = createMemo(() => {
    const current = server.url
    const list = serverUrls()
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const sortedServers = createMemo(() => {
    const list = servers()
    if (!list.length) return list
    const active = server.url
    const order = new Map(list.map((url, index) => [url, index] as const))
    const rank = (value?: ServerHealth) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff = rank(store.status[a]) - rank(store.status[b])
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  async function refreshHealth() {
    const results: Record<string, ServerHealth> = {}
    await Promise.all(
      servers().map(async (url) => {
        results[url] = await checkServerHealth({ url })
      }),
    )
    setStore("status", reconcile(results))
  }

  createEffect(() => {
    servers()
    refreshHealth()
    const interval = setInterval(refreshHealth, 10_000)
    onCleanup(() => clearInterval(interval))
  })

  createEffect(() => {
    const dir = directory()
    if (!dir) return
    const unsub = globalSDK.event.listen((event) => {
      if (event.name !== dir) return
      if (event.details.type === "lsp.updated") {
        void refetchLspStatus()
        return
      }
      if (event.details.type === "server.instance.disposed") {
        void refetchMcpStatus()
        void refetchLspStatus()
      }
    })
    onCleanup(unsub)
  })

  const mcpItems = createMemo(() =>
    Object.entries(mcpStatus() ?? {})
      .map(([name, status]: [string, McpStatus]) => ({ name, status: status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const mcpConnected = createMemo(() => mcpItems().filter((i) => i.status === "connected").length)

  const toggleMcp = async (name: string) => {
    const client = directoryClient()
    if (store.loading || !client) return
    setStore("loading", name)

    try {
      const status = mcpStatus()?.[name]
      await (status?.status === "connected" ? client.mcp.disconnect({ name }) : client.mcp.connect({ name }))
      await refetchMcpStatus()
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setStore("loading", null)
    }
  }

  const lspItems = createMemo(() => lspStatus() ?? [])
  const lspCount = createMemo(() => lspItems().length)
  const pluginName = (plugin: string) => {
    if (plugin.startsWith("file://")) {
      try {
        const name = new URL(plugin).pathname.split("/").filter(Boolean).at(-1)
        if (name) return decodeURIComponent(name).replace(/\.[^.]+$/, "")
      } catch {}
    }
    const lastAt = plugin.lastIndexOf("@")
    return lastAt > 0 ? plugin.substring(0, lastAt) : plugin
  }
  const plugins = createMemo(() =>
    (syncStore()?.config.plugin ?? []).map((plugin) => {
      const id = typeof plugin === "string" ? plugin : plugin[0]
      return { id, name: pluginName(id) }
    }),
  )
  const pluginCount = createMemo(() => plugins().length)

  const overallHealthy = createMemo(() => {
    const serverHealthy = server.healthy() === true
    // Only check MCP if we have a directory context
    const anyMcpIssue = directory()
      ? mcpItems().some((m) => m.status !== "connected" && m.status !== "disabled")
      : false
    return serverHealthy && !anyMcpIssue
  })

  const serverCount = createMemo(() => sortedServers().length)

  const refreshDefaultServerUrl = () => {
    const apply = (key?: ServerConnection.Key | null) => {
      if (!key) {
        setStore("defaultServerUrl", undefined)
        return
      }

      const conn = server.list.find((item) => ServerConnection.key(item) === key)
      setStore("defaultServerUrl", conn?.http.url ?? normalizeServerUrl(key as string))
    }

    const result = platform.getDefaultServer?.()
    if (!result) {
      apply()
      return
    }
    if (result instanceof Promise) {
      result.then(apply)
      return
    }
    apply(result)
  }

  createEffect(() => {
    refreshDefaultServerUrl()
  })

  return (
    <Popover
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class:
          props.triggerClass ??
          "rounded-sm w-[75px] h-[24px] py-1.5 pr-3 pl-2 gap-2 border-none shadow-none data-[expanded]:bg-surface-raised-base-active",
        style: { scale: 1 },
      }}
      trigger={
        (() => {
          const child = props.children
          if (typeof child === "function" && child.length > 0) {
            return (child as Function)({
              overallHealthy: overallHealthy(),
              serverHealthy: server.healthy(),
            })
          }
          return (
            (child as JSX.Element) ?? (
              <div class="flex items-center gap-1.5">
                <div
                  classList={{
                    "size-1.5 rounded-full": true,
                    "bg-icon-success-base": overallHealthy(),
                    "bg-icon-critical-base": !overallHealthy() && server.healthy() !== undefined,
                    "bg-border-weak-base": server.healthy() === undefined,
                  }}
                />
                <span class="text-12-regular text-text-strong">{language.t("status.popover.trigger")}</span>
              </div>
            )
          )
        })()
      }
      class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl"
      onOpenChange={props.onOpenChange}
      gutter={6}
      placement={props.placement ?? "bottom-end"}
      shift={props.placement && props.placement !== "bottom-end" ? 0 : -136}
    >
      <div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
        <Tabs
          aria-label={language.t("status.popover.ariaLabel")}
          class="tabs bg-background-strong rounded-xl overflow-hidden"
          data-component="tabs"
          data-active="servers"
          defaultValue="servers"
          variant="alt"
        >
          <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10">
            <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
              {serverCount() > 0 ? `${serverCount()} ` : ""}
              {language.t("status.popover.tab.servers")}
            </Tabs.Trigger>
            <Show when={!!directory()}>
              <Tabs.Trigger value="mcp" data-slot="tab" class="text-12-regular">
                {mcpConnected() > 0 ? `${mcpConnected()} ` : ""}
                {language.t("status.popover.tab.mcp")}
              </Tabs.Trigger>
              <Tabs.Trigger value="lsp" data-slot="tab" class="text-12-regular">
                {lspCount() > 0 ? `${lspCount()} ` : ""}
                {language.t("status.popover.tab.lsp")}
              </Tabs.Trigger>
              <Tabs.Trigger value="plugins" data-slot="tab" class="text-12-regular">
                {pluginCount() > 0 ? `${pluginCount()} ` : ""}
                {language.t("status.popover.tab.plugins")}
              </Tabs.Trigger>
            </Show>
          </Tabs.List>

          <Tabs.Content value="servers">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <For each={sortedServers()}>
                  {(url) => {
                    const isActive = () => url === server.url
                    const isDefault = () => url === store.defaultServerUrl
                    const status = () => store.status[url]
                    const isBlocked = () => status()?.healthy === false

                    if (isStatusOnly()) {
                      return (
                        <div class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md text-left">
                          <ServerRow
                            conn={ServerConnection.fromUrl(url)}
                            status={status()}
                            class="flex items-center gap-2 w-full min-w-0"
                            nameClass="text-14-regular text-text-base truncate"
                            versionClass="text-12-regular text-text-weak truncate"
                          >
                            <div class="flex-1" />
                            <Show when={isActive()}>
                              <Icon name="check" size="small" class="text-icon-weak-base shrink-0" />
                            </Show>
                          </ServerRow>
                        </div>
                      )
                    }

                    return (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                        classList={{
                          "hover:bg-surface-raised-base-hover": !isBlocked(),
                          "cursor-not-allowed": isBlocked(),
                        }}
                        aria-disabled={isBlocked()}
                        onClick={() => {
                          if (isBlocked()) return
                          server.setActive(url)
                          navigate("/")
                        }}
                      >
                        <ServerRow
                          conn={ServerConnection.fromUrl(url)}
                          status={status()}
                          dimmed={isBlocked()}
                          class="flex items-center gap-2 w-full min-w-0"
                          nameClass="text-14-regular text-text-base truncate"
                          versionClass="text-12-regular text-text-weak truncate"
                          badge={
                            <Show when={isDefault()}>
                              <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                                {language.t("common.default")}
                              </span>
                            </Show>
                          }
                        >
                          <div class="flex-1" />
                          <Show when={isActive()}>
                            <Icon name="check" size="small" class="text-icon-weak-base shrink-0" />
                          </Show>
                        </ServerRow>
                      </button>
                    )
                  }}
                </For>

                <Show when={!isStatusOnly()}>
                  <Button
                    variant="secondary"
                    class="mt-3 self-start h-8 px-3 py-1.5"
                    onClick={() => dialog.show(() => <DialogSelectServer />, refreshDefaultServerUrl)}
                  >
                    {language.t("status.popover.action.manageServers")}
                  </Button>
                </Show>
              </div>
            </div>
          </Tabs.Content>

          <Show when={!!directory()}>
            <Tabs.Content value="mcp">
              <div class="flex flex-col px-2 pb-2">
                <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                  <Show
                    when={mcpItems().length > 0}
                    fallback={
                      <div class="text-14-regular text-text-base text-center my-auto">
                        {language.t("dialog.mcp.empty")}
                      </div>
                    }
                  >
                    <For each={mcpItems()}>
                      {(item) => {
                        const enabled = () => item.status === "connected"
                        return (
                          <button
                            type="button"
                            class="flex items-center gap-2 w-full h-8 pl-3 pr-2 py-1 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                            onClick={() => toggleMcp(item.name)}
                            disabled={store.loading === item.name}
                          >
                            <div
                              classList={{
                                "size-1.5 rounded-full shrink-0": true,
                                "bg-icon-success-base": item.status === "connected",
                                "bg-icon-critical-base": item.status === "failed",
                                "bg-border-weak-base": item.status === "disabled",
                                "bg-icon-warning-base":
                                  item.status === "needs_auth" || item.status === "needs_client_registration",
                              }}
                            />
                            <span class="text-14-regular text-text-base truncate flex-1">{item.name}</span>
                            <div onClick={(event) => event.stopPropagation()}>
                              <Switch
                                checked={enabled()}
                                disabled={store.loading === item.name}
                                onChange={() => toggleMcp(item.name)}
                              />
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </Show>
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="lsp">
              <div class="flex flex-col px-2 pb-2">
                <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                  <Show
                    when={lspItems().length > 0}
                    fallback={
                      <div class="text-14-regular text-text-base text-center my-auto">
                        {language.t("dialog.lsp.empty")}
                      </div>
                    }
                  >
                    <For each={lspItems()}>
                      {(item) => (
                        <div class="flex items-center gap-2 w-full px-2 py-1">
                          <div
                            classList={{
                              "size-1.5 rounded-full shrink-0": true,
                              "bg-icon-success-base": item.status === "connected",
                              "bg-icon-critical-base": item.status === "error",
                            }}
                          />
                          <span class="text-14-regular text-text-base truncate">{item.name || item.id}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="plugins">
              <div class="flex flex-col px-2 pb-2">
                <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                  <Show
                    when={plugins().length > 0}
                    fallback={
                      <div class="text-14-regular text-text-base text-center my-auto">
                        {(() => {
                          const value = language.t("dialog.plugins.empty")
                          const file = "opencode.json"
                          const parts = value.split(file)
                          if (parts.length === 1) return value
                          return (
                            <>
                              {parts[0]}
                              <code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">
                                {file}
                              </code>
                              {parts.slice(1).join(file)}
                            </>
                          )
                        })()}
                      </div>
                    }
                  >
                    <For each={plugins()}>
                      {(plugin) => (
                        <div class="flex items-center gap-2 w-full px-2 py-1">
                          <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                          <span class="text-14-regular text-text-base truncate">{plugin.name}</span>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </Tabs.Content>
          </Show>
        </Tabs>
      </div>
    </Popover>
  )
}
