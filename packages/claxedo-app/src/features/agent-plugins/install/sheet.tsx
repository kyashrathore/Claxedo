// The install sheet the Directory opens on `Add`: two steps, "Where it goes"
// and "Authentication". It owns no catalog state — the Directory hands it the
// candidate and the catalog facts it already read, and hears the outcome back
// through `onDone`.
//
// Dialog lifecycle: the sheet is mounted through `useDialog().show(...)`, which
// is the only place `@opencode-ai/ui/dialog`'s Kobalte content has a root. It
// closes itself on every path EXCEPT "Connect now": the connection port's
// `open` is itself a `dialog.show(...)`, which replaces the whole stack, so
// closing after it would close the connect dialog instead of this one.
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { AgentPluginApi, AgentPluginHarness, PluginCandidate, PluginCatalog } from "@/features/agent-plugins/api"
import type { AgentPluginConnectionPort } from "@/features/agent-plugins/connections"

/** The catalog facts the sheet needs; the Directory owns the catalog itself. */
export type InstallCatalogFacts = {
  /** `PluginCatalog.revision` — the optimistic-concurrency token every mutation carries. */
  revision: number
  projects?: PluginCatalog["projects"]
  supportedHarnesses: AgentPluginHarness[]
  canManageOrganizationDefaults?: boolean
  canManageOrganizationConnections?: boolean
  organizationName?: string
}

export type InstallResult = { installed: boolean; revision?: number }

type OAuthServer = { name: string; integrationId: string; issuers?: readonly string[] }

type HarnessRow = { harnessId: AgentPluginHarness; available: boolean; reason?: string }

const pluginName = (plugin: PluginCandidate) =>
  plugin.manifest?.name ?? plugin.relativePath ?? plugin.pluginInstanceId

const monogram = (text: string) => (text.trim()[0] ?? "?").toUpperCase()

/** The MCP servers that need a connected account before the plugin can run. */
export function oauthServers(plugin: PluginCandidate): OAuthServer[] {
  return plugin.mcpServers.flatMap((server) =>
    server.authentication.state === "oauth"
      ? [{
          name: server.name,
          integrationId: server.authentication.integrationId,
          ...(server.authentication.issuers ? { issuers: server.authentication.issuers } : {}),
        }]
      : [])
}

/**
 * Harness rows for step 1. A harness the candidate cannot serve is the one the
 * catalog already reports as `artifact-unavailable` — the same fact the old
 * catalog used to refuse Enable — so it is shown disabled with that reason.
 */
export function harnessRows(plugin: PluginCandidate, supported: AgentPluginHarness[]): HarnessRow[] {
  return supported.map((harnessId) => {
    const activation = plugin.harnesses[harnessId] as PluginCandidate["harnesses"][AgentPluginHarness] | undefined
    if (!activation) return { harnessId, available: false, reason: "This plugin does not serve this harness" }
    if (activation.effective.status === "artifact-unavailable") {
      return { harnessId, available: false, reason: plugin.artifactError ?? "The plugin artifact is unavailable" }
    }
    return { harnessId, available: true }
  })
}

export function InstallAgentPluginSheet(props: {
  plugin: PluginCandidate
  mode: "signed" | "unsigned"
  catalog: InstallCatalogFacts
  api: AgentPluginApi
  connections?: AgentPluginConnectionPort
  onDone: (result: InstallResult) => void
}): JSX.Element {
  const dialog = useDialog()
  const signed = () => props.mode === "signed"
  const name = () => pluginName(props.plugin)
  const servers = createMemo(() => oauthServers(props.plugin))
  const harnesses = createMemo(() => harnessRows(props.plugin, props.catalog.supportedHarnesses))
  const projects = () => props.catalog.projects ?? []

  const [step, setStep] = createSignal<1 | 2>(1)
  const [projectMode, setProjectMode] = createSignal<"all" | "selected">("all")
  const [selectedProjects, setSelectedProjects] = createSignal(new Set<string>())
  const [selectedHarnesses, setSelectedHarnesses] = createSignal(
    new Set(harnessRows(props.plugin, props.catalog.supportedHarnesses).filter((row) => row.available).map((row) => row.harnessId)),
  )
  const [authority, setAuthority] = createSignal<"personal" | "enterprise">("personal")
  const [issuers, setIssuers] = createSignal<Record<string, string>>({})
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const authenticates = () => servers().length > 0
  const totalSteps = () => (authenticates() ? 2 : 1)

  const enterpriseAvailable = () =>
    props.catalog.canManageOrganizationConnections === true && props.catalog.canManageOrganizationDefaults === true
  const enterpriseReason = () =>
    props.catalog.canManageOrganizationConnections === true
      ? "Only an organization admin can set an organization default"
      : "Only an organization admin can share a connection with the organization"
  const enterprise = () => signed() && enterpriseAvailable() && authority() === "enterprise"

  const issuerFor = (server: OAuthServer) => {
    if (!server.issuers?.length) return undefined
    if (server.issuers.length === 1) return server.issuers[0]
    return issuers()[server.integrationId]
  }
  const issuerMissing = () => servers().some((server) => Boolean(server.issuers?.length) && !issuerFor(server))

  const toggleHarness = (harnessId: AgentPluginHarness, on: boolean) =>
    setSelectedHarnesses((current) => {
      const next = new Set(current)
      if (on) next.add(harnessId)
      else next.delete(harnessId)
      return next
    })

  const toggleProject = (projectId: string, on: boolean) =>
    setSelectedProjects((current) => {
      const next = new Set(current)
      if (on) next.add(projectId)
      else next.delete(projectId)
      return next
    })

  /**
   * Signed activation carries a project target; the local rail refuses project
   * scope by contract, so an unsigned install sends none and lands machine-wide.
   */
  const target = () => {
    if (!signed()) return undefined
    if (projectMode() === "all") return { scope: "all-projects" as const }
    return { scope: "projects" as const, projectIds: [...selectedProjects()] }
  }

  const reportReconciliation = (receipt: { reconciliation: { state: string; message?: string } }) => {
    if (receipt.reconciliation.state !== "failed") return
    showToast({
      title: `${name()} installed, runtime sync pending`,
      description: receipt.reconciliation.message ?? "The runtime will pick the change up on its next reconciliation.",
    })
  }

  /**
   * Each `open` mounts a connect dialog, and the app's port implements it with
   * `dialog.show`, which replaces the stack. Chain them so a plugin with two
   * OAuth servers asks for the second one after the first is connected instead
   * of dropping it behind the last dialog.
   */
  const connect = (queue: OAuthServer[], scope: "personal" | "team") => {
    const [server, ...rest] = queue
    if (!server || !props.connections) return
    const issuer = issuerFor(server)
    props.connections.open({
      integrationId: server.integrationId,
      name: `${server.name} MCP`,
      scope,
      ...(issuer ? { issuer } : {}),
      teamScopeEnabled: props.catalog.canManageOrganizationConnections === true,
      onConnected: () => connect(rest, scope),
    })
  }

  const finish = (result: InstallResult) => {
    props.onDone(result)
    dialog.close()
  }

  const install = async (connectNow: boolean) => {
    setError(undefined)
    setBusy(true)
    try {
      const harnessIds = [...selectedHarnesses()]
      if (harnessIds.length === 0) throw new Error("Select at least one harness")
      const selection = target()
      if (selection?.scope === "projects" && selection.projectIds.length === 0) {
        throw new Error("Select at least one project")
      }
      const receipt = await props.api.activation({
        pluginInstanceId: props.plugin.pluginInstanceId,
        harnessIds,
        choice: true,
        expectedRevision: props.catalog.revision,
        ...(selection ? { target: selection } : {}),
      })
      reportReconciliation(receipt)
      let revision = receipt.revision
      if (enterprise()) {
        const organization = await props.api.organizationDefault({
          pluginInstanceId: props.plugin.pluginInstanceId,
          harnessIds,
          choice: true,
          expectedRevision: revision,
        })
        reportReconciliation(organization)
        revision = organization.revision
      }
      if (connectNow && servers().length > 0 && props.connections) {
        connect(servers(), enterprise() ? "team" : "personal")
        props.onDone({ installed: true, revision })
        return
      }
      finish({ installed: true, revision })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const stepLabel = (value: 1 | 2) => (value === 1 ? "1 Where it goes" : "2 Authentication")

  const header = () => (
    <span class="flex items-center gap-3">
      <Show
        when={props.plugin.icon?.kind === "url" ? props.plugin.icon : undefined}
        fallback={
          <span
            aria-hidden="true"
            class="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-interactive-base text-14-medium text-text-on-interactive-base"
          >
            {props.plugin.icon?.kind === "monogram" ? props.plugin.icon.text : monogram(name())}
          </span>
        }
      >
        {(icon) => <img src={icon().url} alt="" class="size-10 shrink-0 rounded-lg object-cover" />}
      </Show>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">Add {name()}</span>
        <span class="flex items-center gap-1.5 text-12-regular text-text-weaker">
          <span class="text-text-base">{stepLabel(step())}</span>
          <Show when={authenticates()}>
            <span>·</span>
            <span>{stepLabel(step() === 1 ? 2 : 1)}</span>
          </Show>
        </span>
      </span>
    </span>
  )

  const optionClass = (selected: boolean, disabled: boolean) =>
    [
      "grid grid-cols-[auto_1fr_auto] items-start gap-2.5 rounded-lg border bg-surface-raised-base px-2.5 py-2.5",
      selected ? "border-border-interactive-base" : "border-border-weak-base",
      disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
    ].join(" ")

  return (
    <Dialog title={header()} size="large" transition>
      <div class="flex flex-col">
        <Show when={step() === 1}>
          <section class="flex flex-col gap-2.5 border-b border-border-weak-base py-3" aria-label="Environments">
            <div class="flex items-baseline justify-between gap-2">
              <h4 class="text-13-medium text-text-strong">Environments</h4>
              <span class="text-11-regular text-text-weaker">both, always</span>
            </div>
            <p class="text-12-regular text-text-weak">Plugins reach every environment you sign into.</p>
            <div class="grid grid-cols-2 gap-1.5">
              <label class={optionClass(false, true)}>
                <input type="checkbox" checked disabled />
                <span>
                  <span class="block text-13-medium text-text-strong">Local</span>
                  <span class="block text-12-regular text-text-weak">This machine</span>
                </span>
              </label>
              <label class={optionClass(false, true)}>
                <input type="checkbox" checked disabled />
                <span>
                  <span class="block text-13-medium text-text-strong">Cloud</span>
                  <span class="block text-12-regular text-text-weak">Your cloud workspaces</span>
                </span>
              </label>
            </div>
          </section>

          <section class="flex flex-col gap-2.5 border-b border-border-weak-base py-3" aria-label="Projects">
            <h4 class="text-13-medium text-text-strong">Projects</h4>
            <Show
              when={signed()}
              fallback={<p class="text-12-regular text-text-weak">Applies to every project on this machine</p>}
            >
              <div class="grid gap-1.5" role="radiogroup" aria-label="Project target">
                <label class={optionClass(projectMode() === "all", false)}>
                  <input
                    type="radio"
                    name="install-project-target"
                    checked={projectMode() === "all"}
                    onChange={() => setProjectMode("all")}
                  />
                  <span>
                    <span class="block text-13-medium text-text-strong">All projects</span>
                    <span class="block text-12-regular text-text-weak">Current and future projects in this organization</span>
                  </span>
                </label>
                <label class={optionClass(projectMode() === "selected", false)}>
                  <input
                    type="radio"
                    name="install-project-target"
                    checked={projectMode() === "selected"}
                    onChange={() => setProjectMode("selected")}
                  />
                  <span>
                    <span class="block text-13-medium text-text-strong">Only these projects</span>
                    <Show
                      when={projectMode() === "selected"}
                      fallback={<span class="block text-12-regular text-text-weak">Pick from the organization's projects</span>}
                    >
                      <span class="mt-2 flex flex-wrap gap-2">
                        <For each={projects()}>
                          {(project) => (
                            <label class="inline-flex items-center gap-1.5 rounded-lg border border-border-weak-base bg-surface-base px-2.5 py-1.5 text-12-regular text-text-base">
                              <input
                                type="checkbox"
                                checked={selectedProjects().has(project.id)}
                                onChange={(event) => toggleProject(project.id, event.currentTarget.checked)}
                              />
                              {project.label}
                            </label>
                          )}
                        </For>
                      </span>
                    </Show>
                  </span>
                </label>
              </div>
            </Show>
          </section>

          <section class="flex flex-col gap-2.5 py-3" aria-label="Harnesses">
            <h4 class="text-13-medium text-text-strong">Harnesses</h4>
            <p class="text-12-regular text-text-weak">Where the skills and MCP servers are materialized.</p>
            <div class="flex flex-wrap gap-2">
              <For each={harnesses()}>
                {(row) => (
                  <label
                    class="inline-flex items-center gap-1.5 rounded-lg border border-border-weak-base bg-surface-raised-base px-2.5 py-1.5 text-13-regular text-text-base"
                    classList={{ "cursor-not-allowed opacity-55": !row.available }}
                    title={row.reason}
                  >
                    <input
                      type="checkbox"
                      checked={selectedHarnesses().has(row.harnessId)}
                      disabled={!row.available}
                      onChange={(event) => toggleHarness(row.harnessId, event.currentTarget.checked)}
                    />
                    {row.harnessId}
                    <Show when={row.reason}>
                      {(reason) => <span class="text-11-regular text-text-weaker">{reason()}</span>}
                    </Show>
                  </label>
                )}
              </For>
            </div>
          </section>
        </Show>

        <Show when={step() === 2}>
          <section class="flex flex-col gap-2.5 py-3" aria-label="Authentication">
            <h4 class="text-13-medium text-text-strong">
              Who authenticates {servers().map((server) => server.name).join(", ")}
            </h4>
            <p class="text-12-regular text-text-weak">This plugin's MCP server needs a connected account.</p>
            <div class="grid gap-1.5" role="radiogroup" aria-label="Authentication authority">
              <label class={optionClass(authority() === "personal", false)}>
                <input
                  type="radio"
                  name="install-authentication"
                  checked={authority() === "personal"}
                  onChange={() => setAuthority("personal")}
                />
                <span>
                  <span class="block text-13-medium text-text-strong">Personal — only you</span>
                  <span class="block text-12-regular text-text-weak">
                    Used in your interactive turns, on every machine and cloud workspace you sign into.
                  </span>
                </span>
              </label>
              <Show when={signed()}>
                <label class={optionClass(authority() === "enterprise", !enterpriseAvailable())}>
                  <input
                    type="radio"
                    name="install-authentication"
                    checked={authority() === "enterprise"}
                    disabled={!enterpriseAvailable()}
                    onChange={() => setAuthority("enterprise")}
                  />
                  <span>
                    <span class="block text-13-medium text-text-strong">
                      Enterprise — everyone in {props.catalog.organizationName ?? "your organization"}
                    </span>
                    <span class="block text-12-regular text-text-weak">
                      Team connection plus an organization default: every member gets it enabled.
                    </span>
                  </span>
                  <span class="text-11-regular text-text-weaker">
                    {enterpriseAvailable() ? "admin" : enterpriseReason()}
                  </span>
                </label>
              </Show>
            </div>
            <For each={servers().filter((server) => (server.issuers?.length ?? 0) > 1)}>
              {(server) => (
                <label class="flex flex-col gap-1 text-12-regular text-text-weak">
                  <span>{server.name} authorization server</span>
                  <select
                    aria-label={`${server.name} authorization server`}
                    class="rounded border border-border-weak-base bg-background-base px-2 py-1 text-13-regular text-text-base"
                    value={issuers()[server.integrationId] ?? ""}
                    onChange={(event) =>
                      setIssuers((current) => ({ ...current, [server.integrationId]: event.currentTarget.value }))}
                  >
                    <option value="">Choose an authorization server</option>
                    <For each={server.issuers}>{(issuer) => <option value={issuer}>{issuer}</option>}</For>
                  </select>
                </label>
              )}
            </For>
            <p class="rounded-lg border border-dashed border-border-strong-base px-2.5 py-2 text-12-regular text-text-weak">
              Connect now opens the provider's consent page once. <span class="text-text-strong">Connect later</span>{" "}
              installs anyway and lists the plugin under Needs attention.
            </p>
          </section>
        </Show>

        <Show when={error()}>
          {(message) => (
            <div role="alert" class="py-2 text-13-regular text-icon-critical-base">
              {message()}
            </div>
          )}
        </Show>

        <footer class="flex items-center justify-between gap-2 border-t border-border-weak-base pt-3">
          <span class="text-12-regular text-text-weaker">
            Step {step()} of {totalSteps()}
          </span>
          <div class="flex gap-2">
            <Show
              when={step() === 2}
              fallback={
                <Button size="large" variant="secondary" disabled={busy()} onClick={() => finish({ installed: false })}>
                  Cancel
                </Button>
              }
            >
              <Button size="large" variant="secondary" disabled={busy()} onClick={() => setStep(1)}>
                Back
              </Button>
            </Show>
            <Show when={step() === 1 && authenticates()}>
              <Button size="large" variant="primary" onClick={() => setStep(2)}>
                Next: Authentication
              </Button>
            </Show>
            <Show when={step() === 1 && !authenticates()}>
              <Button size="large" variant="primary" disabled={busy()} onClick={() => void install(false)}>
                {busy() ? "Adding…" : "Add plugin"}
              </Button>
            </Show>
            <Show when={step() === 2}>
              <Button size="large" variant="secondary" disabled={busy()} onClick={() => void install(false)}>
                Connect later
              </Button>
              <Button
                size="large"
                variant="primary"
                disabled={busy() || issuerMissing()}
                onClick={() => void install(true)}
              >
                Connect now
              </Button>
            </Show>
          </div>
        </footer>
      </div>
    </Dialog>
  )
}
