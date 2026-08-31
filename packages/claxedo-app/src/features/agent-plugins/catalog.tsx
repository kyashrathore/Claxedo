import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import type { AgentPluginApi, AgentPluginHarness, PluginCandidate } from "./api"

const label = (plugin: PluginCandidate) => plugin.manifest?.name ?? plugin.relativePath ?? plugin.pluginInstanceId

type ActivationTarget = "all-current" | "all-future" | "selected"

function isActivationTarget(value: string): value is ActivationTarget {
  return value === "all-current" || value === "all-future" || value === "selected"
}

export type AgentPluginConnectionSummary = {
  id: string
  integrationId: string
  scope: "personal" | "team"
  status: "connected" | "degraded" | "broken"
}

export type AgentPluginConnectionPort = {
  load(): Promise<{ connections: AgentPluginConnectionSummary[] }>
  open(input: {
    integrationId: string
    name: string
    scope: "personal" | "team"
    issuer?: string
    teamScopeEnabled: boolean
    onConnected(): void | Promise<void>
  }): void
  disconnect(connectionId: string): Promise<void>
}

const CONNECTION_STATUS = {
  connected: "connected",
  degraded: "needs reconnection",
  broken: "missing credential",
} as const

export function AgentPluginCatalog(props: {
  mode: "signed" | "unsigned"
  api: AgentPluginApi
  connections?: AgentPluginConnectionPort
}) {
  const signed = () => props.mode === "signed"
  const [fresh, setFresh] = createSignal(false)
  const [projectId, setProjectId] = createSignal<string>()
  const [target, setTarget] = createSignal<ActivationTarget>("all-current")
  const [selectedProjects, setSelectedProjects] = createSignal(new Set<string>())
  const [catalog, { refetch }] = createResource(
    () => ({ mode: props.mode, refresh: fresh(), projectId: signed() ? projectId() : undefined }),
    (options) => props.api.catalog(options),
  )
  const [connections, { refetch: refetchConnections }] = createResource(
    () => signed() && props.connections ? "signed" : undefined,
    () => props.connections!.load(),
  )
  const [selected, setSelected] = createSignal(new Set<AgentPluginHarness>())
  const [selectedIssuers, setSelectedIssuers] = createSignal<Record<string, string>>({})
  const [pending, setPending] = createSignal<string>()

  const harnesses = createMemo(() => catalog()?.supportedHarnesses ?? [])
  const chosenHarnesses = () => {
    const values = [...selected()]
    return values.length > 0 ? values : harnesses()
  }

  const mutate = async (plugin: PluginCandidate, choice: boolean | null) => {
    const current = catalog()
    if (!current) return
    setPending(plugin.pluginInstanceId)
    try {
      const targetSelection = signed()
        ? target() === "all-future"
          ? { scope: "all-projects" as const }
          : {
              scope: "projects" as const,
              projectIds: target() === "all-current"
                ? (current.projects ?? []).map((project) => project.id)
                : [...selectedProjects()],
            }
        : undefined
      if (signed() && targetSelection?.scope === "projects" && targetSelection.projectIds.length === 0) {
        throw new Error("Select at least one project")
      }
      const result = await props.api.activation({
        pluginInstanceId: plugin.pluginInstanceId,
        harnessIds: chosenHarnesses(),
        choice,
        expectedRevision: current.revision,
        ...(targetSelection ? { target: targetSelection } : {}),
      })
      if (result.reconciliation.state === "failed") {
        showToast({ title: "Activation saved", description: result.reconciliation.message ?? "Runtime reconciliation will be retried." })
      }
      setFresh(false)
      await refetch()
      if (signed() && props.connections) await refetchConnections()
    } catch (error) {
      showToast({ title: "Could not change plugin", description: error instanceof Error ? error.message : String(error) })
    } finally {
      setPending(undefined)
    }
  }

  const update = async (plugin: PluginCandidate) => {
    const current = catalog()
    if (!current) return
    setPending(plugin.pluginInstanceId)
    try {
      await props.api.update({
        pluginInstanceId: plugin.pluginInstanceId,
        expectedRevision: current.revision,
        ...(signed() ? { authority: "user" as const } : {}),
      })
      setFresh(false)
      await refetch()
      if (signed() && props.connections) await refetchConnections()
    } catch (error) {
      showToast({ title: "Could not update plugin", description: error instanceof Error ? error.message : String(error) })
    } finally {
      setPending(undefined)
    }
  }

  const organizationDefault = async (plugin: PluginCandidate, choice: true | null) => {
    const current = catalog()
    if (!current) return
    setPending(plugin.pluginInstanceId)
    try {
      await props.api.organizationDefault({
        pluginInstanceId: plugin.pluginInstanceId,
        harnessIds: chosenHarnesses(),
        choice,
        expectedRevision: current.revision,
      })
      setFresh(false)
      await refetch()
    } catch (error) {
      showToast({ title: "Could not change organization default", description: error instanceof Error ? error.message : String(error) })
    } finally {
      setPending(undefined)
    }
  }

  const connectionFor = (integrationId: string, scope: AgentPluginConnectionSummary["scope"]) =>
    connections()?.connections.find((connection) => connection.integrationId === integrationId && connection.scope === scope)

  const openConnection = (
    serverName: string,
    integrationId: string,
    scope: AgentPluginConnectionSummary["scope"],
    issuer?: string,
  ) => {
    props.connections?.open({
      integrationId,
      name: `${serverName} MCP`,
      scope,
      ...(issuer ? { issuer } : {}),
      teamScopeEnabled: catalog()?.canManageOrganizationConnections === true,
      onConnected: async () => { await refetchConnections() },
    })
  }

  const disconnect = async (connection: AgentPluginConnectionSummary) => {
    try {
      await props.connections?.disconnect(connection.id)
      await refetchConnections()
      showToast({ variant: "success", icon: "circle-check", title: "MCP connection disconnected" })
    } catch (error) {
      showToast({ variant: "error", title: "Could not disconnect MCP", description: error instanceof Error ? error.message : String(error) })
    }
  }

  const refresh = async () => {
    setFresh(true)
    await refetch()
  }

  return (
    <main data-agent-plugins-catalog class="h-full overflow-y-auto bg-background-base px-6 py-5">
      <div class="mx-auto flex max-w-5xl flex-col gap-5">
        <header class="flex items-start justify-between gap-4">
          <div>
            <h1 class="text-lg font-semibold text-text-strong">Plugins</h1>
            <p class="mt-1 text-sm text-text-weak">
              {signed() ? "Choose which projects receive standard Agent Plugins." : "Enable standard Agent Plugins for the harnesses on this machine."}
            </p>
          </div>
          <button class="rounded border border-border-weak-base px-3 py-1.5 text-sm text-text-base" onClick={refresh} disabled={catalog.loading}>
            {catalog.loading ? "Refreshing…" : "Refresh catalog"}
          </button>
        </header>

        <Show when={signed()}>
          <section aria-label="Project targets" class="grid gap-3 rounded-md border border-border-weak-base/50 p-3">
            <label class="grid gap-1 text-sm text-text-base">
              <span class="text-xs font-medium uppercase tracking-wide text-text-weaker">Inspect effective state for</span>
              <select class="rounded border border-border-weak-base bg-background-base px-2 py-1.5" value={projectId() ?? ""} onChange={(event) => setProjectId(event.currentTarget.value || undefined)}>
                <option value="">Cross-project defaults</option>
                <For each={catalog()?.projects ?? []}>{(project) => <option value={project.id}>{project.label}</option>}</For>
              </select>
            </label>
            <label class="grid gap-1 text-sm text-text-base">
              <span class="text-xs font-medium uppercase tracking-wide text-text-weaker">When Enable or Disable is clicked</span>
              <select class="rounded border border-border-weak-base bg-background-base px-2 py-1.5" value={target()} onChange={(event) => {
                if (isActivationTarget(event.currentTarget.value)) setTarget(event.currentTarget.value)
              }}>
                <option value="all-current">All current projects</option>
                <option value="all-future">All current and future projects</option>
                <option value="selected">Selected projects</option>
              </select>
            </label>
            <Show when={target() === "selected"}>
              <div class="flex flex-wrap gap-3">
                <For each={catalog()?.projects ?? []}>{(project) => (
                  <label class="flex items-center gap-1.5 text-sm text-text-base">
                    <input type="checkbox" checked={selectedProjects().has(project.id)} onChange={(event) => setSelectedProjects((previous) => {
                      const next = new Set(previous)
                      event.currentTarget.checked ? next.add(project.id) : next.delete(project.id)
                      return next
                    })} />
                    {project.label}
                  </label>
                )}</For>
              </div>
            </Show>
          </section>
        </Show>

        <section aria-label="Harness targets" class="flex flex-wrap items-center gap-3 rounded-md border border-border-weak-base/50 p-3">
          <span class="text-xs font-medium uppercase tracking-wide text-text-weaker">Harness targets</span>
          <For each={harnesses()}>{(harness) => (
            <label class="flex items-center gap-1.5 text-sm text-text-base">
              <input
                type="checkbox"
                checked={selected().has(harness)}
                onChange={(event) => setSelected((previous) => {
                  const next = new Set(previous)
                  event.currentTarget.checked ? next.add(harness) : next.delete(harness)
                  return next
                })}
              />
              {harness}
            </label>
          )}</For>
          <Show when={selected().size === 0}><span class="text-xs text-text-weaker">No selection means all harnesses.</span></Show>
        </section>

        <Show when={catalog.error}>
          <div role="alert" class="rounded-md border border-border-critical-base bg-surface-critical-base/10 p-4 text-sm text-text-on-critical-base">{String(catalog.error)}</div>
        </Show>

        <Show when={catalog()?.errors.length}>
          <section class="rounded-md border border-border-weak-base p-4">
            <h2 class="text-sm font-medium text-text-strong">Invalid catalog entries</h2>
            <For each={catalog()?.errors}>{(error) => <p class="mt-1 text-xs text-text-weak">{error.sourceId}/{error.relativePath}: {error.message}</p>}</For>
          </section>
        </Show>

        <div class="grid gap-3">
          <For each={catalog()?.candidates ?? []}>{(plugin) => {
            const enabled = () => Object.values(plugin.harnesses).some((state) => state.effective.effective)
            const organizationDefaultEnabled = () => chosenHarnesses().some((harness) => plugin.harnesses[harness].organizationDefault)
            const organizationEligible = () => plugin.sourceKind === "claxedo"
              || plugin.sourceKind === "organization"
              || Object.values(plugin.harnesses).some((state) => state.organizationDefault)
            return (
              <article class="rounded-lg border border-border-weak-base/50 bg-surface-raised-base/20 p-4">
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-baseline gap-2">
                      <h2 class="font-medium text-text-strong">{label(plugin)}</h2>
                      <Show when={plugin.manifest?.version}><span class="text-xs text-text-weaker">v{plugin.manifest?.version}</span></Show>
                      <span class="text-xs text-text-weaker">{plugin.sourceLabel ?? "retained artifact"}</span>
                    </div>
                    <Show when={plugin.manifest?.description}><p class="mt-1 text-sm text-text-weak">{plugin.manifest?.description}</p></Show>
                    <div class="mt-2 flex flex-wrap gap-2">
                      <For each={harnesses()}>{(harness) => (
                        <span class="rounded bg-surface-base px-2 py-0.5 text-xs text-text-weaker">
                          {harness}: {plugin.harnesses[harness].effective.effective ? "enabled" : "disabled"}
                        </span>
                      )}</For>
                    </div>
                    <Show when={!plugin.sourceAvailable}><p class="mt-2 text-xs text-text-weak">Source unavailable; retained bytes remain usable.</p></Show>
                    <Show when={plugin.artifactError}><p class="mt-2 text-xs text-text-on-critical-base">{plugin.artifactError}</p></Show>
                  </div>
                  <div class="flex shrink-0 flex-wrap justify-end gap-2">
                    <Show when={plugin.updateAvailable}>
                      <button class="rounded border border-border-weak-base px-2.5 py-1 text-xs" disabled={pending() === plugin.pluginInstanceId} onClick={() => update(plugin)}>Update</button>
                    </Show>
                    <Show when={signed() && catalog()?.canManageOrganizationDefaults && organizationEligible()}>
                      <button
                        class="rounded border border-border-weak-base px-2.5 py-1 text-xs"
                        disabled={pending() === plugin.pluginInstanceId || (!plugin.sourceAvailable && !plugin.retainedDigest)}
                        onClick={() => organizationDefault(plugin, organizationDefaultEnabled() ? null : true)}
                      >
                        {organizationDefaultEnabled() ? "Remove organization default" : "Enable for organization"}
                      </button>
                    </Show>
                    <button class="rounded border border-border-weak-base px-2.5 py-1 text-xs" disabled={pending() === plugin.pluginInstanceId} onClick={() => mutate(plugin, null)}>Use default</button>
                    <button
                      class="rounded bg-surface-interactive-base px-2.5 py-1 text-xs text-text-on-interactive-base disabled:opacity-50"
                      disabled={pending() === plugin.pluginInstanceId || (!plugin.sourceAvailable && !plugin.retainedDigest)}
                      onClick={() => mutate(plugin, !enabled())}
                    >
                      {pending() === plugin.pluginInstanceId ? "Applying…" : enabled() ? "Disable" : "Enable"}
                    </button>
                  </div>
                </div>
                <Show when={plugin.mcpServers.length > 0}>
                  <div class="mt-4 grid gap-2 border-t border-border-weak-base/50 pt-3" aria-label={`${label(plugin)} MCP servers`}>
                    <div class="text-xs font-medium uppercase tracking-wide text-text-weaker">MCP servers</div>
                    <For each={plugin.mcpServers}>{(server) => {
                      const authentication = server.authentication
                      if (authentication.state === "oauth") {
                        const issuerKey = `${plugin.pluginInstanceId}\0${server.name}`
                        const selectedIssuer = () => authentication.issuers?.length
                          ? selectedIssuers()[issuerKey]
                          : undefined
                        const issuerRequired = () => Boolean(authentication.issuers?.length && !selectedIssuer())
                        const personal = () => connectionFor(authentication.integrationId, "personal")
                        const organization = () => connectionFor(authentication.integrationId, "team")
                        const effective = () => personal() ?? organization()
                        return (
                          <div class="flex flex-wrap items-center justify-between gap-3 rounded bg-surface-base px-3 py-2">
                            <div class="min-w-0 text-xs text-text-base">
                              <div class="font-medium text-text-strong">{server.name}</div>
                              <Show
                                when={effective()}
                                fallback={<div>{plugin.retainedDigest ? "Connection required" : "Enable the plugin before connecting"}</div>}
                              >
                                {(connection) => (
                                  <div>
                                    {connection().scope === "personal" ? "Personal" : "Organization"} connection: {CONNECTION_STATUS[connection().status]}
                                    <Show when={connection().scope === "personal" && organization()}>
                                      <span> (overrides organization)</span>
                                    </Show>
                                  </div>
                                )}
                              </Show>
                              <Show when={authentication.issuers?.length}>
                                <label class="mt-2 grid gap-1">
                                  <span class="text-text-weaker">Authorization server</span>
                                  <select
                                    aria-label={`${server.name} authorization server`}
                                    class="rounded border border-border-weak-base bg-background-base px-2 py-1"
                                    value={selectedIssuer() ?? ""}
                                    onChange={(event) => setSelectedIssuers((current) => ({
                                      ...current,
                                      [issuerKey]: event.currentTarget.value,
                                    }))}
                                  >
                                    <option value="">Choose an authorization server</option>
                                    <For each={authentication.issuers}>{(issuer) => <option value={issuer}>{issuer}</option>}</For>
                                  </select>
                                </label>
                              </Show>
                            </div>
                            <div class="flex flex-wrap justify-end gap-2">
                              <button
                                class="rounded border border-border-weak-base px-2.5 py-1 text-xs disabled:opacity-50"
                                disabled={!plugin.retainedDigest || connections.loading || issuerRequired()}
                                onClick={() => openConnection(server.name, authentication.integrationId, "personal", selectedIssuer())}
                              >
                                {personal() ? "Reconnect" : "Connect"}
                              </button>
                              <Show when={personal()}>
                                {(connection) => <button class="rounded border border-border-weak-base px-2.5 py-1 text-xs" onClick={() => disconnect(connection())}>Disconnect</button>}
                              </Show>
                              <Show when={catalog()?.canManageOrganizationConnections}>
                                <button
                                  class="rounded border border-border-weak-base px-2.5 py-1 text-xs disabled:opacity-50"
                                  disabled={!plugin.retainedDigest || connections.loading || issuerRequired()}
                                  onClick={() => openConnection(server.name, authentication.integrationId, "team", selectedIssuer())}
                                >
                                  {organization() ? "Reconnect organization" : "Connect for organization"}
                                </button>
                                <Show when={organization()}>
                                  {(connection) => <button class="rounded border border-border-weak-base px-2.5 py-1 text-xs" onClick={() => disconnect(connection())}>Disconnect organization</button>}
                                </Show>
                              </Show>
                            </div>
                          </div>
                        )
                      }
                      let message: string
                      if (authentication.state === "public") message = "No connection required"
                      else if (authentication.state === "local") message = "Runs locally"
                      else if (authentication.state === "harness") message = "Authentication is handled by the selected harness"
                      else message = `Unavailable: ${("reason" in authentication ? authentication.reason : "unknown").replaceAll("_", " ")}`
                      return (
                        <div class="flex items-center justify-between gap-3 rounded bg-surface-base px-3 py-2 text-xs text-text-base">
                          <span class="font-medium text-text-strong">{server.name}</span>
                          <span>{message}</span>
                        </div>
                      )
                    }}</For>
                    <Show when={connections.error}>
                      <div class="text-xs text-icon-critical-base">Connections unavailable: {String(connections.error)}</div>
                    </Show>
                  </div>
                </Show>
              </article>
            )
          }}</For>
        </div>
      </div>
    </main>
  )
}
