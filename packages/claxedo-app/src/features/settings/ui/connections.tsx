// Connections settings section: lists integrations from the claxedo-server
// connections host (/api/claxedo/integrations) with per-integration status,
// connect/reconnect/disconnect/re-verify actions, and the connect dialog.
// The token endpoint under this route family is host-internal and is never
// called from the UI.
import type { SourceProvider, SourceSyncPolicy, SourceViewDto, SourceViewTarget } from "@claxedo/workgraph/contracts"
import { createMemo, createSignal, For, onMount, Show, type Component, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Tag } from "@opencode-ai/ui/tag"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import {
  DialogConnectIntegration,
  useSettingsSourceViews,
  type SourceViewProject,
} from "@/features/settings/app-ports"
import {
  createConnectionsStore,
  createSourceViewsStore,
  type ConnectionInfo,
  type ConnectionsRequest,
  type IntegrationInfo,
} from "./connections-logic"

/** All UI traffic goes through the authenticated fetch helper, same-origin to the control plane. */
const integrationsRequest: ConnectionsRequest = (path, init) =>
  authFetch(new URL(`/api/claxedo/integrations${path}`, getClaxedoServerUrl()).toString(), init)

const STATUS_LABEL: Record<ConnectionInfo["status"], string> = {
  connected: "Connected",
  degraded: "Degraded",
  broken: "Broken",
}

const sourceViewInput = "h-8 w-full rounded-md border border-border-base bg-surface-base px-2.5 text-12-regular text-text-base outline-none transition-colors focus:border-border-focus-base"

function StatusChip(props: { status: ConnectionInfo["status"] }) {
  return (
    <span class="inline-flex items-center gap-1.5">
      <span
        class="shrink-0 size-2 rounded-full"
        classList={{
          "bg-surface-success-strong": props.status === "connected",
          "bg-surface-warning-strong": props.status === "degraded",
          "bg-surface-critical-strong": props.status === "broken",
        }}
      />
      <span
        class="text-12-medium"
        classList={{
          "text-text-base": props.status === "connected",
          "text-icon-warning-base": props.status === "degraded",
          "text-icon-critical-base": props.status === "broken",
        }}
      >
        {STATUS_LABEL[props.status]}
      </span>
    </span>
  )
}

export const SettingsConnections: Component = () => {
  const dialog = useDialog()
  const store = createConnectionsStore({ request: integrationsRequest })
  const sourceViewPort = useSettingsSourceViews()
  const sourceViews = createSourceViewsStore(sourceViewPort)
  const [confirming, setConfirming] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal<string | undefined>(undefined)
  const [editingView, setEditingView] = createSignal<SourceViewDto | "new">()
  const [editingConnection, setEditingConnection] = createSignal<ConnectionInfo>()

  onMount(() => void Promise.all([store.load(), sourceViews.load()]))

  const openConnect = (integration: IntegrationInfo, scope?: ConnectionInfo["scope"]) => {
    dialog.show(() => (
      <DialogConnectIntegration
        integration={integration}
        request={integrationsRequest}
        onConnected={() => store.load()}
        personalScopeEnabled={store.state.personalScopeEnabled}
        initialScope={scope}
      />
    ))
  }

  const disconnect = async (integration: IntegrationInfo, connection: ConnectionInfo) => {
    setConfirming(undefined)
    setBusy(connection.id)
    const result = await store.disconnect(connection.id)
    setBusy(undefined)
    if (result.ok) {
      showToast({ variant: "success", icon: "circle-check", title: `${integration.name} disconnected` })
      return
    }
    showToast({ variant: "error", title: result.error ?? "Disconnect failed" })
  }

  const reverify = async (integration: IntegrationInfo, connection: ConnectionInfo) => {
    setBusy(connection.id)
    const result = await store.reverify(connection.id)
    setBusy(undefined)
    if (result.ok) {
      showToast({ variant: "success", icon: "circle-check", title: `${integration.name} verified` })
      return
    }
    showToast({ variant: "error", title: `${integration.name} verification failed`, description: result.error })
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
        <h2 class="text-18-medium text-text-strong">Connections</h2>
        <p class="text-13-regular text-text-weak">
          Connect external tools like Notion, GitHub, and Atlassian so agents can use them.
        </p>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <div class="flex flex-col gap-1" data-component="connections-section">
          <Show when={store.state.error}>
            {(error) => <div class="py-2 text-13-regular text-icon-critical-base">{error()}</div>}
          </Show>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <Show
              when={store.state.integrations.length > 0}
              fallback={
                <div class="py-4 text-14-regular text-text-weak">
                  {store.state.loading ? "Loading connections…" : "No integrations available."}
                </div>
              }
            >
              <For each={store.state.integrations}>
                {(integration) => {
                  const connections = () => store.connectionsFor(integration.id)
                  return (
                    <div class="flex flex-col gap-3 min-h-16 py-3 border-b border-border-weak-base last:border-none" data-integration={integration.id}>
                      <div class="flex flex-wrap items-center justify-between gap-4">
                        <div class="flex flex-col gap-1 min-w-0">
                          <span class="text-14-medium text-text-strong">{integration.name}</span>
                          <div class="flex flex-wrap items-center gap-1">
                            <For each={integration.capabilities}>{(capability) => <Tag>{capability}</Tag>}</For>
                          </div>
                        </div>
                        <Button size="small" variant="secondary" icon="plus-small" onClick={() => openConnect(integration)}>
                          {connections().length > 0 ? "Add connection" : "Connect"}
                        </Button>
                      </div>
                      <Show when={connections().length > 0}>
                        <div class="flex flex-col gap-2">
                          <For each={connections()}>
                            {(connection) => {
                              const status = () => connection.status
                              const provider = () => sourceProvider(connection.integrationId)
                              const sourceCapable = () => !!provider() && connection.grantedCapabilities.includes("work-source")
                              const views = () => sourceViews.state.views.filter((view) => view.teamConnectionId === connection.id)
                              return (
                                <div class="flex flex-col gap-3 rounded-md bg-surface-base px-3 py-2">
                                  <div class="flex flex-wrap items-center justify-between gap-4">
                                    <div class="flex flex-col gap-1 min-w-0">
                                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                                      <Show when={store.state.personalScopeEnabled}>
                                        <Tag>{connection.scope === "personal" ? "Only me" : "Team"}</Tag>
                                      </Show>
                                      <StatusChip status={status()} />
                                      <Show when={connection.accountLabel}>
                                        {(label) => <span class="text-12-regular text-text-weak">{label()}</span>}
                                      </Show>
                                    </div>
                                    </div>
                                    <div class="flex items-center gap-2 shrink-0">
                                    <Show when={status() === "degraded"}>
                                      <Button
                                        size="small"
                                        variant="secondary"
                                        disabled={busy() === connection.id}
                                        onClick={() => void reverify(integration, connection)}
                                      >
                                        Re-verify
                                      </Button>
                                    </Show>
                                    <Show when={status() === "degraded" || status() === "broken"}>
                                      <Button size="small" variant="secondary" onClick={() => openConnect(integration, connection.scope)}>
                                        Reconnect
                                      </Button>
                                    </Show>
                                    <Show
                                      when={confirming() === connection.id}
                                      fallback={
                                        <Button
                                          size="small"
                                          variant="ghost"
                                          disabled={busy() === connection.id}
                                          onClick={() => setConfirming(connection.id)}
                                        >
                                          Disconnect
                                        </Button>
                                      }
                                    >
                                      <span class="text-12-regular text-text-weak">Disconnect?</span>
                                      <Button
                                        size="small"
                                        variant="primary"
                                        disabled={busy() === connection.id}
                                        onClick={() => void disconnect(integration, connection)}
                                      >
                                        Confirm
                                      </Button>
                                      <Button size="small" variant="ghost" onClick={() => setConfirming(undefined)}>
                                        Cancel
                                      </Button>
                                      </Show>
                                      <Show when={sourceCapable() && connection.scope === "team" && status() === "connected"}>
                                        <Button size="small" variant="secondary" onClick={() => {
                                          setEditingConnection(connection)
                                          setEditingView("new")
                                        }}>Add issue source</Button>
                                      </Show>
                                    </div>
                                  </div>
                                  <Show when={sourceCapable() && connection.scope === "team"}>
                                    <div class="border-t border-border-weak-base pt-2">
                                      <Show when={views().length > 0} fallback={<p class="text-12-regular text-text-weaker py-1">No personal issue sources for this account.</p>}>
                                        <For each={views()}>{(view) => (
                                          <SourceViewRow
                                            view={view}
                                            busy={sourceViews.state.busy === view.id}
                                            refreshResult={sourceViews.state.refreshResult[view.id]}
                                            projects={sourceViewPort.projects()}
                                            onEdit={() => {
                                              setEditingConnection(connection)
                                              setEditingView(view)
                                            }}
                                            onRefresh={() => void sourceViews.refresh(view)}
                                            onToggle={() => void sourceViews.update(view, {
                                              providerUserId: view.providerUserId,
                                              filters: view.filters,
                                              ...(view.target ? { target: view.target } : {}),
                                              syncPolicy: view.syncPolicy,
                                              status: view.status === "active" ? "paused" : "active",
                                            })}
                                            onDelete={() => void sourceViews.remove(view)}
                                          />
                                        )}</For>
                                      </Show>
                                    </div>
                                  </Show>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>
          <Show when={sourceViews.state.error}>{(error) => <div class="pt-3 text-13-regular text-icon-critical-base" role="alert">{error()}</div>}</Show>
          <Show when={editingView() && editingConnection() && sourceProvider(editingConnection()!.integrationId)}>
            <SourceViewForm
                connection={editingConnection()!}
                provider={sourceProvider(editingConnection()!.integrationId)!}
                view={editingView() === "new" ? undefined : editingView() as SourceViewDto}
                projects={sourceViewPort.projects()}
                busy={sourceViews.state.busy !== undefined}
                onCancel={() => {
                  setEditingView()
                  setEditingConnection()
                }}
                onSave={async (input) => {
                  const view = editingView()
                  const saved = view === "new"
                    ? await sourceViews.create({ teamConnectionId: editingConnection()!.id as never, provider: input.provider, providerUserId: input.providerUserId, filters: input.filters, target: input.target, syncPolicy: input.syncPolicy })
                    : await sourceViews.update(view!, { providerUserId: input.providerUserId, filters: input.filters, target: input.target, syncPolicy: input.syncPolicy, status: view!.status })
                  if (!saved) return
                  setEditingView()
                  setEditingConnection()
                }}
            />
          </Show>
        </div>
      </div>
    </div>
  )
}

function SourceViewRow(props: {
  view: SourceViewDto
  projects: SourceViewProject[]
  busy: boolean
  refreshResult?: string
  onEdit: () => void
  onRefresh: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  const target = () => props.projects.find((project) => sameProjectTarget(project.target, props.view.target))?.label
    ?? sourceTargetLabel(props.view.target)
  return (
    <div class="grid grid-cols-1 items-center gap-3 py-2 border-b border-border-weak-base last:border-none md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-12-medium text-text-base truncate">{props.view.providerUserId}</span>
          <Tag>{props.view.status === "active" ? "Active" : "Paused"}</Tag>
        </div>
        <p class="text-11-regular text-text-weaker truncate">{sourceFilterLabel(props.view)}</p>
      </div>
      <div class="min-w-0 md:border-l md:border-border-weak-base md:pl-3">
        <p class="text-11-medium text-text-base truncate">{target()}</p>
        <p class="text-11-regular text-text-weaker truncate">Base {props.view.target?.repository.baseRevision ?? "not mapped"}{props.refreshResult ? ` · ${props.refreshResult}` : ""}</p>
      </div>
      <div class="flex flex-wrap items-center gap-1 md:justify-end">
        <Button size="small" variant="ghost" disabled={props.busy} onClick={props.onRefresh}>Refresh</Button>
        <Button size="small" variant="ghost" disabled={props.busy} onClick={props.onToggle}>{props.view.status === "active" ? "Pause" : "Resume"}</Button>
        <Button size="small" variant="ghost" disabled={props.busy} onClick={props.onEdit}>Edit</Button>
        <Show when={confirmingDelete()} fallback={<Button size="small" variant="ghost" disabled={props.busy} onClick={() => setConfirmingDelete(true)}>Delete</Button>}>
          <span class="text-11-regular text-text-weaker">Delete?</span>
          <Button size="small" variant="primary" disabled={props.busy} onClick={props.onDelete}>Confirm</Button>
          <Button size="small" variant="ghost" disabled={props.busy} onClick={() => setConfirmingDelete(false)}>Cancel</Button>
        </Show>
      </div>
    </div>
  )
}

export function SourceViewForm(props: {
  connection: ConnectionInfo
  provider: SourceProvider
  view?: SourceViewDto
  projects: SourceViewProject[]
  busy: boolean
  onCancel: () => void
  onSave: (input: { provider: SourceProvider; providerUserId: string; filters: Record<string, string>; target: SourceViewTarget; syncPolicy: SourceSyncPolicy }) => Promise<void>
}) {
  const [providerUserId, setProviderUserId] = createSignal(props.view?.providerUserId ?? "")
  const [repo, setRepo] = createSignal(props.view?.filters.repo ?? "")
  const [state, setState] = createSignal(props.view?.filters.state ?? "open")
  const [labels, setLabels] = createSignal(props.view?.filters.labels ?? "")
  const [team, setTeam] = createSignal(props.view?.filters.team ?? "")
  const [jql, setJql] = createSignal(props.view?.filters.jql ?? "")
  const [syncPolicy, setSyncPolicy] = createSignal<SourceSyncPolicy>(props.view?.syncPolicy ?? "announce")
  const [baseRevision, setBaseRevision] = createSignal(props.view?.target?.repository.baseRevision ?? "HEAD")
  const initialProject = props.projects.find((project) => sameProjectTarget(project.target, props.view?.target))?.id
  const [projectId, setProjectId] = createSignal(initialProject ?? (props.view?.provider === "github" && props.view.target ? "github-repository" : ""))
  const githubTarget = createMemo<SourceViewTarget | undefined>(() => {
    const repository = repo().trim()
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) return
    const repositoryUrl = `https://github.com/${repository}.git`
    return {
      environment: { kind: "hosted_workspace", placement: "shared", repositoryUrl },
      repository: { remoteUrl: repositoryUrl, baseRevision: baseRevision().trim() || "HEAD" },
    }
  })
  const selectedTarget = createMemo(() => {
    const target = projectId() === "github-repository"
      ? githubTarget()
      : props.projects.find((project) => project.id === projectId())?.target
    if (!target) return
    return { ...target, repository: { ...target.repository, baseRevision: baseRevision().trim() || "HEAD" } }
  })
  const filters = () => Object.fromEntries(Object.entries(props.provider === "github"
    ? { repo: repo(), state: state(), labels: labels() }
    : props.provider === "linear" ? { team: team() } : { jql: jql() })
    .map(([key, value]) => [key, value.trim()])
    .filter(([, value]) => value))
  const canSave = () => !!providerUserId().trim() && !!selectedTarget()

  return (
    <div class="mt-4 rounded-lg border border-border-base bg-surface-raised-base p-4" data-component="source-view-form">
      <div class="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 class="text-14-medium text-text-strong">{props.view ? "Edit issue source" : "Add issue source"}</h3>
          <p class="text-12-regular text-text-weak">Map personal {props.provider} issues from {props.connection.accountLabel ?? props.connection.integrationId} into a Stream project.</p>
        </div>
        <Tag>{props.provider}</Tag>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
        <div class="flex flex-col gap-3">
          <div class="text-11-medium uppercase tracking-wide text-text-weaker">Issues</div>
          <SettingsField label="Your provider identity" description="Used to find work assigned to you.">
            <input class={sourceViewInput} value={providerUserId()} onInput={(event) => setProviderUserId(event.currentTarget.value)} />
          </SettingsField>
          <Show when={props.provider === "github"}>
            <SettingsField label="Repository" description="GitHub owner/repository."><input class={sourceViewInput} placeholder="claxedo/claxedo" value={repo()} onInput={(event) => {
              setRepo(event.currentTarget.value)
              if (!projectId()) setProjectId("github-repository")
            }} /></SettingsField>
            <SettingsField label="State" description="Issue state filter."><select class={sourceViewInput} value={state()} onChange={(event) => setState(event.currentTarget.value)}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All</option></select></SettingsField>
            <SettingsField label="Labels" description="Comma-separated labels; optional."><input class={sourceViewInput} value={labels()} onInput={(event) => setLabels(event.currentTarget.value)} /></SettingsField>
          </Show>
          <Show when={props.provider === "linear"}><SettingsField label="Team" description="Linear team key; optional."><input class={sourceViewInput} value={team()} onInput={(event) => setTeam(event.currentTarget.value)} /></SettingsField></Show>
          <Show when={props.provider === "jira"}><SettingsField label="JQL" description="Allowlisted query used to find assigned issues."><input class={sourceViewInput} value={jql()} onInput={(event) => setJql(event.currentTarget.value)} /></SettingsField></Show>
        </div>
        <div class="flex flex-col gap-3 md:border-l md:border-border-weak-base md:pl-6">
          <div class="text-11-medium uppercase tracking-wide text-text-weaker">Stream target</div>
          <SettingsField label="Project" description="Directory or cloud repository materialized on admitted Streams.">
            <select class={sourceViewInput} value={projectId()} onChange={(event) => setProjectId(event.currentTarget.value)}>
              <option value="">Select a project</option>
              <Show when={props.provider === "github" && githubTarget()}><option value="github-repository">GitHub repository · cloud</option></Show>
              <For each={props.projects}>{(project) => <option value={project.id}>{project.label}</option>}</For>
            </select>
          </SettingsField>
          <SettingsField label="Base revision" description="Branch, tag, or revision used when the Stream starts."><input class={sourceViewInput} value={baseRevision()} onInput={(event) => setBaseRevision(event.currentTarget.value)} /></SettingsField>
          <SettingsField label="Result sync" description="How meaningful completion results return to the provider.">
            <select class={sourceViewInput} value={syncPolicy()} onChange={(event) => setSyncPolicy(event.currentTarget.value as SourceSyncPolicy)}>
              <option value="announce">Comment with results</option><option value="full">Comment and update status</option><option value="silent">Do not sync</option>
            </select>
          </SettingsField>
          <p class="text-11-regular text-text-weaker">Credentials remain in Connections. WorkGraph stores only this identity, filter, and project mapping.</p>
        </div>
      </div>
      <div class="flex justify-end gap-2 mt-5">
        <Button size="small" variant="ghost" onClick={props.onCancel}>Cancel</Button>
        <Button size="small" variant="primary" disabled={props.busy || !canSave()} onClick={() => void props.onSave({ provider: props.provider, providerUserId: providerUserId().trim(), filters: filters(), target: selectedTarget()!, syncPolicy: syncPolicy() })}>{props.busy ? "Saving…" : "Save source"}</Button>
      </div>
    </div>
  )
}

function SettingsField(props: { label: string; description: string; children: JSX.Element }) {
  return <label class="flex flex-col gap-1"><span class="text-12-medium text-text-base">{props.label}</span><span class="text-11-regular text-text-weaker">{props.description}</span>{props.children}</label>
}

function sourceProvider(integrationId: string): SourceProvider | undefined {
  if (integrationId === "github" || integrationId === "linear") return integrationId
  if (integrationId === "jira" || integrationId === "atlassian") return "jira"
}

function sameProjectTarget(left: SourceViewTarget, right?: SourceViewTarget) {
  if (!right || left.environment.kind !== right.environment.kind) return false
  if (left.repository.remoteUrl !== right.repository.remoteUrl) return false
  if (left.environment.kind === "local_worktree" && right.environment.kind === "local_worktree") {
    return left.environment.directory === right.environment.directory
  }
  if (left.environment.kind === "hosted_workspace" && right.environment.kind === "hosted_workspace") {
    return left.environment.repositoryUrl === right.environment.repositoryUrl
  }
  return false
}

function sourceTargetLabel(target?: SourceViewTarget) {
  if (!target) return "Target not mapped"
  return target.environment.kind === "local_worktree" ? target.environment.directory : target.environment.repositoryUrl
}

function sourceFilterLabel(view: SourceViewDto) {
  return Object.entries(view.filters).map(([key, value]) => `${key}: ${value}`).join(" · ") || "All assigned issues"
}
