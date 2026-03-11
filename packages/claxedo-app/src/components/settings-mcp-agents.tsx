/**
 * MCP Agents Settings
 *
 * Shows per-agent toggles for managed MCP servers.
 */

import { Component, createSignal, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"

const AGENT_LABELS: Record<string, { label: string; description: string }> = {
  opencode: {
    label: "OpenCode",
    description: "Built-in opencode sessions",
  },
  claude: {
    label: "Claude",
    description: "Anthropic Claude Code CLI",
  },
  gemini: {
    label: "Gemini",
    description: "Google Gemini CLI",
  },
  cursor: {
    label: "Cursor",
    description: "Cursor agent",
  },
}

const SERVER_LABELS: Record<string, { label: string; description: string }> = {
  "claxedo-mcp": {
    label: "claxedo-mcp",
    description: "Tab context, process management, and other Claxedo tools.",
  },
}

export const SettingsMcpAgents: Component = () => {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? globalThis.fetch

  const [store, setStore] = createStore<{
    servers: Record<string, Record<string, boolean>>
    managed: string[]
    capable: string[]
    ready: boolean
  }>({ servers: {}, managed: [], capable: [], ready: false })

  const [loading, setLoading] = createSignal<string | null>(null)

  const headers = () => ({
    "Content-Type": "application/json",
  })

  onMount(async () => {
    try {
      const res = await fetchFn(`${globalSDK.url}/hook/mcp-agents`, { headers: headers() })
      if (res.ok) {
        const data = (await res.json()) as {
          servers: Record<string, Record<string, boolean>>
          managed: string[]
          capable: string[]
        }
        setStore({ servers: data.servers, managed: data.managed, capable: data.capable, ready: true })
        return
      }
    } catch {
      // Server may not be ready yet
    }
    setStore("ready", true)
  })

  const toggle = async (server: string, agent: string) => {
    if (loading()) return
    setLoading(`${server}:${agent}`)
    const newValue = store.servers[server]?.[agent] === false
    try {
      const res = await fetchFn(`${globalSDK.url}/hook/mcp-agents`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ server, agent, enabled: newValue }),
      })
      if (res.ok) {
        setStore("servers", server, agent, newValue)
        showToast({
          title: `${server} ${newValue ? "enabled" : "disabled"} for ${AGENT_LABELS[agent]?.label ?? agent}`,
          variant: "success",
          duration: 3000,
        })
      } else {
        const err = await res.json().catch(() => ({ error: "Unknown error" }))
        showToast({ title: (err as { error: string }).error, variant: "error", duration: 5000 })
      }
    } catch {
      showToast({ title: "Failed to toggle MCP", variant: "error", duration: 5000 })
    } finally {
      setLoading(null)
    }
  }

  const serverInfo = (server: string) =>
    SERVER_LABELS[server] ?? {
      label: server,
      description: "Managed MCP server injected into supported agent configs.",
    }

  const count = (server: string) => store.capable.filter((agent) => store.servers[server]?.[agent] !== false).length

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">MCP Servers</h2>
          <p class="max-w-[560px] text-12-regular text-text-weak">
            Enable or disable managed MCP servers for each supported agent.
          </p>
        </div>
      </div>

      <Show
        when={store.ready}
        fallback={
          <div class="rounded-2xl border border-border-weak-base bg-surface-raised-base px-4 py-5 text-13-regular text-text-weak">
            Loading managed MCP servers...
          </div>
        }
      >
        <Show
          when={store.managed.length > 0}
          fallback={
            <div class="rounded-2xl border border-dashed border-border-weak-base bg-surface-raised-base px-5 py-6">
              <div class="text-14-medium text-text-strong">No managed MCP servers</div>
              <p class="pt-1 text-13-regular text-text-weak">
                This workspace does not expose any app-managed MCP servers yet.
              </p>
            </div>
          }
        >
          <div class="flex flex-col gap-6 w-full">
            <For each={store.managed}>
              {(server) => (
                <section class="flex flex-col gap-2">
                  <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                      <h3 class="text-14-medium text-text-strong">{serverInfo(server).label}</h3>
                      <p class="pt-1 text-12-regular text-text-weak">{serverInfo(server).description}</p>
                    </div>
                    <div class="shrink-0 text-12-medium text-text-weak">
                      {count(server)}/{store.capable.length}
                    </div>
                  </div>

                  <div class="bg-surface-raised-base px-4 rounded-lg">
                    <For each={store.capable}>
                      {(agent) => {
                        const info = () => AGENT_LABELS[agent] ?? { label: agent, description: "" }
                        const enabled = () => store.servers[server]?.[agent] !== false
                        const busy = () => loading() === `${server}:${agent}`
                        return (
                          <button
                            class="group flex w-full items-center justify-between gap-4 border-b border-border-weak-base py-3 text-left transition-colors last:border-b-0 hover:bg-surface-base-hover/30"
                            classList={{
                              "opacity-70": busy(),
                            }}
                            onClick={() => toggle(server, agent)}
                            disabled={!!loading()}
                          >
                            <div class="min-w-0">
                              <div class="text-14-medium text-text-strong">{info().label}</div>
                            </div>

                            <div class="shrink-0" onClick={(e) => e.stopPropagation()}>
                              <Switch checked={enabled()} disabled={busy()} onChange={() => toggle(server, agent)} />
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
