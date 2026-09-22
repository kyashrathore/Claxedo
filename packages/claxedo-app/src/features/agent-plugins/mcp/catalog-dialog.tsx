import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useLanguage } from "@/platform/i18n/provider"
import { withCurrentRevision, type AgentPluginApi, type PluginCandidate, type PluginCatalog } from "@/features/agent-plugins/api"
import { oauthServers } from "@/features/agent-plugins/connections"
import { requestConfirm } from "@/ui/dialogs/confirm"
import { installedHarnesses, isInstalled, matchesQuery, pluginLabel } from "@/features/agent-plugins/directory/view"

/** The MCP servers a plugin ships are the catalog's own account of what it serves. */
const servesMcp = (plugin: PluginCandidate) => plugin.mcpServers.length > 0

const reason = (value: unknown) => value instanceof Error ? value.message : String(value)

/**
 * The composer's slash-mcp surface: the MCP half of the plugin catalog, in a
 * dialog, so a running session can add a server without leaving the pane.
 *
 * It decides nothing the Directory does not: rows come from the same catalog
 * read, "Install" hands the plugin to the same install sheet, and "Uninstall"
 * posts the same revision-guarded activation. A server whose account is held
 * over OAuth is sent to the Directory, which owns connect and disconnect.
 */
export function McpCatalogDialog(props: {
  mode: "signed" | "unsigned"
  api: AgentPluginApi
  onInstall: (plugin: PluginCandidate, catalog: PluginCatalog) => void | Promise<unknown>
  onOpenDirectory: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const [busy, setBusy] = createSignal("")
  const [catalog, { refetch }] = createResource(() => props.api.catalog())

  const entries = createMemo(() => {
    const text = query().trim().toLowerCase()
    return (catalog()?.candidates ?? []).filter((plugin) => servesMcp(plugin) && matchesQuery(plugin, text))
  })

  /**
   * A signed choice names the projects it covers; the local rail refuses
   * project scope by contract, so an unsigned choice sends none and lands
   * machine-wide. Same rule the Directory applies to the same route.
   */
  const target = (current: PluginCatalog) => {
    if (props.mode !== "signed") return undefined
    const projectIds = (current.projects ?? []).map((project) => project.id)
    return projectIds.length > 0
      ? { scope: "projects" as const, projectIds }
      : { scope: "all-projects" as const }
  }

  const uninstall = async (plugin: PluginCandidate) => {
    const current = catalog()
    if (!current) return
    const confirmed = await requestConfirm(dialog, {
      title: language.t("dialog.mcp.uninstall.confirm.title", { name: pluginLabel(plugin) }),
      body: language.t("dialog.mcp.uninstall.confirm.body"),
      confirmLabel: language.t("dialog.mcp.uninstall"),
      cancelLabel: language.t("common.cancel"),
    })
    if (!confirmed) return
    setBusy(plugin.pluginInstanceId)
    try {
      const selection = target(current)
      await withCurrentRevision({
        revision: () => catalog()?.revision,
        reread: async () => {
          await refetch()
        },
        run: (expectedRevision) => props.api.activation({
          pluginInstanceId: plugin.pluginInstanceId,
          harnessIds: current.supportedHarnesses,
          choice: false,
          expectedRevision,
          ...(selection ? { target: selection } : {}),
        }),
      })
      await refetch()
    } catch (error) {
      showToast({
        title: language.t("dialog.mcp.uninstall.failed", { name: pluginLabel(plugin) }),
        description: reason(error),
        variant: "error",
      })
    } finally {
      setBusy("")
    }
  }

  const install = async (plugin: PluginCandidate) => {
    const current = catalog()
    if (!current) return
    await props.onInstall(plugin, current)
    await refetch()
  }

  return (
    <Dialog title={language.t("dialog.mcp.title")} description={language.t("dialog.mcp.description")} size="large">
      <div class="flex max-h-[70vh] flex-col gap-4">
        <label class="flex min-h-10 items-center gap-2 rounded-md border border-border-weak-base bg-surface-raised-base px-3">
          <Icon name="magnifying-glass" size="small" class="text-icon-weak-base" />
          <input
            autofocus
            aria-label={language.t("dialog.mcp.search.placeholder")}
            class="min-w-0 flex-1 bg-transparent text-14-regular text-text-base outline-none placeholder:text-text-weaker"
            placeholder={language.t("dialog.mcp.search.placeholder")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>

        <Show when={catalog.loading}>
          <div class="py-10 text-center text-13-regular text-text-weak">{language.t("common.loading")}</div>
        </Show>
        <Show when={catalog.error !== undefined}>
          <div role="alert" class="rounded-md border border-border-weak-base bg-surface-raised-base px-4 py-5 text-13-regular text-text-weak">
            {language.t("dialog.mcp.error", { message: reason(catalog.error) })}
          </div>
        </Show>
        <Show when={catalog() && !catalog.loading}>
          <div class="min-h-0 overflow-y-auto pr-1">
            <Show
              when={entries().length > 0}
              fallback={
                <div class="grid place-items-center rounded-md border border-dashed border-border-weak-base px-5 py-10 text-13-regular text-text-weak">
                  {language.t("dialog.mcp.empty")}
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={entries()}>
                  {(plugin) => {
                    const pending = () => busy() === plugin.pluginInstanceId
                    const mutable = () => plugin.sourceAvailable || Boolean(plugin.retainedDigest)
                    return (
                      <div
                        class="flex items-start justify-between gap-4 rounded-md border border-border-weak-base bg-surface-raised-base px-3 py-3"
                        data-testid={`mcp-entry-${plugin.pluginInstanceId}`}
                      >
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-14-medium text-text-strong">{pluginLabel(plugin)}</span>
                            <Show when={plugin.source?.label}>
                              {(label) => (
                                <span class="rounded bg-surface-base px-1.5 py-px text-10-medium uppercase tracking-wide text-text-weak">
                                  {label()}
                                </span>
                              )}
                            </Show>
                            <Show when={isInstalled(plugin)}>
                              <span class="rounded bg-surface-success-base px-1.5 py-px text-10-medium uppercase tracking-wide text-text-on-success-base">
                                {language.t("dialog.mcp.installed")}
                              </span>
                            </Show>
                          </div>
                          <Show when={plugin.manifest?.description}>
                            {(description) => <p class="mt-1 text-12-regular text-text-base">{description()}</p>}
                          </Show>
                          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-11-regular text-text-weak">
                            <span>{plugin.mcpServers.map((server) => server.name).join(", ")}</span>
                            <Show when={installedHarnesses(plugin).length > 0}>
                              <span>{installedHarnesses(plugin).join(", ")}</span>
                            </Show>
                          </div>
                          <Show when={oauthServers(plugin).length > 0}>
                            <button
                              type="button"
                              class="mt-2 text-11-medium text-text-strong underline-offset-2 hover:underline"
                              onClick={() => props.onOpenDirectory()}
                            >
                              {language.t("dialog.mcp.connections")}
                            </button>
                          </Show>
                        </div>
                        <div class="shrink-0">
                          <Show
                            when={isInstalled(plugin)}
                            fallback={
                              <Button
                                size="small"
                                variant="secondary"
                                disabled={pending() || !mutable()}
                                onClick={() => void install(plugin)}
                              >
                                {language.t("dialog.mcp.install")}
                              </Button>
                            }
                          >
                            <Button size="small" variant="ghost" disabled={pending()} onClick={() => void uninstall(plugin)}>
                              {language.t("dialog.mcp.uninstall")}
                            </Button>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
