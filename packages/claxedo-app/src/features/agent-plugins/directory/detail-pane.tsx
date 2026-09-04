import { createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Markdown } from "@/ui/session-kit"
import type { AgentPluginApi, PluginCandidate, PluginCatalog, PluginSkill } from "../api"
import { AGENT_PLUGIN_CONNECTION_STATUS, type AgentPluginConnectionSummary } from "../connections"
import { PluginIconTile } from "./plugin-icon"
import { StateChip } from "./state-chip"
import {
  connectionFor,
  installedHarnesses,
  isInstalled,
  oauthServers,
  pluginLabel,
  stateChip,
} from "./view"

const ROW = "rounded-lg border border-border-weak-base bg-surface-raised-base px-2.5 py-2"
const HEADING = "text-11-medium uppercase tracking-wide text-text-weaker"

/** One skill row; its SKILL.md is read from the retained artifact on expand. */
function SkillRow(props: {
  skill: PluginSkill
  api: AgentPluginApi
  pluginInstanceId: string
  projectId?: string
}) {
  const [open, setOpen] = createSignal(false)
  const [document] = createResource(
    () => open() ? { pluginInstanceId: props.pluginInstanceId, skill: props.skill.name, projectId: props.projectId } : undefined,
    (options) => props.api.skill({
      pluginInstanceId: options.pluginInstanceId,
      skill: options.skill,
      ...(options.projectId ? { projectId: options.projectId } : {}),
    }),
  )
  return (
    <div class={`${ROW} mb-1.5`} data-agent-plugin-skill={props.skill.name}>
      <button
        type="button"
        class="grid w-full grid-cols-[1fr_auto] items-center gap-2 text-left"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <span class="min-w-0">
          <span class="block truncate text-12-mono text-text-strong">{props.skill.name}</span>
          <span class="block truncate text-12-regular text-text-weak">{props.skill.description}</span>
        </span>
        <span class="text-12-regular text-text-weaker">SKILL.md {open() ? "▴" : "▾"}</span>
      </button>
      <Show when={open()}>
        <div class="mt-2 border-t border-border-weak-base pt-2 text-12-regular text-text-weak">
          <Show when={document.error}>
            <span class="text-icon-critical-base">{String(document.error)}</span>
          </Show>
          <Show when={document.loading}><span>Reading SKILL.md…</span></Show>
          <Show when={document()}>{(loaded) => <Markdown text={loaded().markdown} />}</Show>
        </div>
      </Show>
    </div>
  )
}

/**
 * The Directory's detail pane: everything known about one plugin, and every
 * action that changes it.
 *
 * The activation, update, organization-default and connection calls stay in the
 * Directory (one owner for the catalog revision and the refetch); this
 * component only decides what is shown and when an action is legal.
 */
export function PluginDetailPane(props: {
  plugin: PluginCandidate
  signed: boolean
  catalog: PluginCatalog
  api: AgentPluginApi
  projectId?: string
  connections?: readonly AgentPluginConnectionSummary[]
  connectionsLoading: boolean
  connectionsError?: unknown
  pending: boolean
  onAdd: () => void
  onActivate: (choice: boolean | null) => void
  onUpdate: () => void
  onOrganizationDefault: (choice: true | null) => void
  onConnect: (input: { serverName: string; integrationId: string; scope: "personal" | "team"; issuer?: string }) => void
  onDisconnect: (connection: AgentPluginConnectionSummary) => void
  onClose: () => void
}) {
  const [issuers, setIssuers] = createSignal<Record<string, string>>({})
  const name = () => pluginLabel(props.plugin)
  const installed = () => isInstalled(props.plugin)
  const retained = () => Boolean(props.plugin.retainedDigest)
  const chip = () => stateChip({
    plugin: props.plugin,
    ...(props.connections ? { connections: props.connections } : {}),
  })
  // Ported unchanged from the catalog article: an organization default is only
  // offered for collections the organization can own.
  const organizationDefaultEnabled = () => props.catalog.supportedHarnesses
    .some((harness) => props.plugin.harnesses[harness].organizationDefault)
  const organizationEligible = () => props.plugin.sourceKind === "claxedo"
    || props.plugin.sourceKind === "organization"
    || Object.values(props.plugin.harnesses).some((state) => state.organizationDefault)
  const mutable = () => props.plugin.sourceAvailable || retained()

  const authentication = () => {
    const servers = oauthServers(props.plugin)
    if (servers.length === 0) return undefined
    if (servers.some((server) => connectionFor(props.connections, server.integrationId, "personal"))) return "Personal"
    if (servers.some((server) => connectionFor(props.connections, server.integrationId, "team"))) return "Enterprise (team)"
    return undefined
  }

  return (
    <aside
      data-component="agent-plugin-detail"
      aria-label={`${name()} details`}
      class="flex w-[400px] max-w-full shrink-0 flex-col overflow-y-auto border-l border-border-weak-base bg-surface-base"
    >
      <header class="grid grid-cols-[auto_1fr_auto] items-start gap-3 border-b border-border-weak-base p-4">
        <PluginIconTile icon={props.plugin.icon} name={name()} size="pane" />
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-16-medium text-text-strong">{name()}</h2>
            <Show when={chip()}>{(value) => <StateChip chip={value()} />}</Show>
          </div>
          <div class="mt-0.5 flex flex-wrap items-center gap-2 text-12-regular text-text-weak">
            <Show when={props.plugin.manifest?.version}>{(version) => <span class="text-12-mono">v{version()}</span>}</Show>
            <span>{props.plugin.source?.label ?? "retained artifact"}</span>
            <Show when={props.plugin.source?.repository}>{(repository) => <span class="text-12-mono">{repository()}</span>}</Show>
          </div>
        </div>
        <Button size="small" variant="ghost" aria-label="Close details" onClick={() => props.onClose()}>×</Button>
      </header>

      <Show when={props.plugin.manifest?.description}>
        {(description) => <p class="px-4 pt-3 text-13-regular text-text-base">{description()}</p>}
      </Show>
      <Show when={!props.plugin.sourceAvailable}>
        <p class="px-4 pt-2 text-12-regular text-text-weak">Source unavailable; retained bytes remain usable.</p>
      </Show>
      <Show when={props.plugin.artifactError}>
        {(error) => <p class="px-4 pt-2 text-12-regular text-icon-critical-base">{error()}</p>}
      </Show>

      <div class="flex flex-wrap gap-2 p-4">
        <Show
          when={installed()}
          fallback={
            <Show
              when={retained()}
              fallback={
                <Button size="small" variant="primary" disabled={props.pending || !mutable()} onClick={() => props.onAdd()}>
                  Add
                </Button>
              }
            >
              <Button size="small" variant="primary" disabled={props.pending || !mutable()} onClick={() => props.onActivate(true)}>
                {props.pending ? "Applying…" : "Enable"}
              </Button>
            </Show>
          }
        >
          <Button size="small" variant="secondary" disabled={props.pending || !mutable()} onClick={() => props.onActivate(false)}>
            {props.pending ? "Applying…" : "Disable"}
          </Button>
        </Show>
        <Button size="small" variant="ghost" disabled={props.pending} onClick={() => props.onActivate(null)}>Use default</Button>
        <Show when={props.plugin.updateAvailable}>
          <Button size="small" variant="secondary" disabled={props.pending} onClick={() => props.onUpdate()}>Update</Button>
        </Show>
        <Show when={props.signed && props.catalog.canManageOrganizationDefaults && organizationEligible()}>
          <Button
            size="small"
            variant="ghost"
            disabled={props.pending || !mutable()}
            onClick={() => props.onOrganizationDefault(organizationDefaultEnabled() ? null : true)}
          >
            {organizationDefaultEnabled() ? "Remove organization default" : "Enable for organization"}
          </Button>
        </Show>
      </div>

      <section class="border-t border-border-weak-base px-4 pb-4">
        <h3 class={`${HEADING} pt-3 pb-2`}>Skills <span class="text-text-weaker">{props.plugin.skills.length}</span></h3>
        <Show when={props.plugin.skills.length > 0} fallback={<p class={`${ROW} text-12-regular text-text-weak`}>This plugin has no skills.</p>}>
          <For each={props.plugin.skills}>
            {(skill) => (
              <SkillRow
                skill={skill}
                api={props.api}
                pluginInstanceId={props.plugin.pluginInstanceId}
                projectId={props.projectId}
              />
            )}
          </For>
        </Show>
      </section>

      <section class="border-t border-border-weak-base px-4 pb-4" aria-label={`${name()} MCP servers`}>
        <h3 class={`${HEADING} pt-3 pb-2`}>MCP servers <span class="text-text-weaker">{props.plugin.mcpServers.length}</span></h3>
        <Show
          when={props.plugin.mcpServers.length > 0}
          fallback={<p class={`${ROW} text-12-regular text-text-weak`}>This plugin has no MCP servers.</p>}
        >
          <For each={props.plugin.mcpServers}>
            {(server) => {
              const auth = server.authentication
              if (auth.state !== "oauth") {
                const message = auth.state === "public"
                  ? "No connection required"
                  : auth.state === "local"
                    ? "Runs locally"
                    : auth.state === "harness"
                      ? "Authentication is handled by the selected harness"
                      : `Unavailable: ${("reason" in auth ? auth.reason : "unknown").replaceAll("_", " ")}`
                return (
                  <div class={`${ROW} mb-1.5 grid grid-cols-[1fr_auto] items-center gap-2`}>
                    <div class="min-w-0">
                      <div class="truncate text-12-mono text-text-strong">{server.name}</div>
                      <div class="text-12-regular text-text-weak">{server.type}</div>
                    </div>
                    <span class="text-12-regular text-text-weak">{message}</span>
                  </div>
                )
              }
              const key = `${props.plugin.pluginInstanceId}\0${server.name}`
              const issuer = () => auth.issuers?.length ? issuers()[key] : undefined
              const issuerRequired = () => Boolean(auth.issuers?.length && !issuer())
              const personal = () => connectionFor(props.connections, auth.integrationId, "personal")
              const organization = () => connectionFor(props.connections, auth.integrationId, "team")
              const effective = () => personal() ?? organization()
              return (
                <div class={`${ROW} mb-1.5 grid gap-2`}>
                  <div class="grid grid-cols-[1fr_auto] items-start gap-2">
                    <div class="min-w-0 text-12-regular text-text-base">
                      <div class="truncate text-12-mono text-text-strong">{server.name}</div>
                      <div class="text-text-weak">{server.type} · OAuth</div>
                      <Show
                        when={effective()}
                        fallback={<div>{retained() ? "Connection required" : "Enable the plugin before connecting"}</div>}
                      >
                        {(connection) => (
                          <div>
                            {connection().scope === "personal" ? "Personal" : "Organization"} connection:{" "}
                            {AGENT_PLUGIN_CONNECTION_STATUS[connection().status]}
                            <Show when={connection().scope === "personal" && organization()}>
                              <span> (overrides organization)</span>
                            </Show>
                          </div>
                        )}
                      </Show>
                    </div>
                  </div>
                  <Show when={auth.issuers?.length}>
                    <label class="grid gap-1 text-12-regular text-text-weak">
                      <span>Authorization server</span>
                      <select
                        aria-label={`${server.name} authorization server`}
                        class="rounded-md border border-border-weak-base bg-background-base px-2 py-1 text-12-regular text-text-base"
                        value={issuer() ?? ""}
                        onChange={(event) => setIssuers((current) => ({ ...current, [key]: event.currentTarget.value }))}
                      >
                        <option value="">Choose an authorization server</option>
                        <For each={auth.issuers}>{(option) => <option value={option}>{option}</option>}</For>
                      </select>
                    </label>
                  </Show>
                  <div class="flex flex-wrap gap-2">
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={!retained() || props.connectionsLoading || issuerRequired()}
                      onClick={() => props.onConnect({
                        serverName: server.name,
                        integrationId: auth.integrationId,
                        scope: "personal",
                        ...(issuer() ? { issuer: issuer()! } : {}),
                      })}
                    >
                      {personal() ? "Reconnect" : "Connect"}
                    </Button>
                    <Show when={personal()}>
                      {(connection) => (
                        <Button size="small" variant="ghost" onClick={() => props.onDisconnect(connection())}>Disconnect</Button>
                      )}
                    </Show>
                    <Show when={props.catalog.canManageOrganizationConnections}>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={!retained() || props.connectionsLoading || issuerRequired()}
                        onClick={() => props.onConnect({
                          serverName: server.name,
                          integrationId: auth.integrationId,
                          scope: "team",
                          ...(issuer() ? { issuer: issuer()! } : {}),
                        })}
                      >
                        {organization() ? "Reconnect organization" : "Connect for organization"}
                      </Button>
                      <Show when={organization()}>
                        {(connection) => (
                          <Button size="small" variant="ghost" onClick={() => props.onDisconnect(connection())}>
                            Disconnect organization
                          </Button>
                        )}
                      </Show>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </Show>
        <Show when={props.connectionsError}>
          <p class="text-12-regular text-icon-critical-base">Connections unavailable: {String(props.connectionsError)}</p>
        </Show>
      </section>

      <section class="border-t border-border-weak-base px-4 pb-6">
        <h3 class={`${HEADING} pt-3 pb-2`}>Where it is installed</h3>
        <Show
          when={installed()}
          fallback={
            <p class="text-12-regular text-text-weak">
              Not installed. Add it to choose projects, harnesses, and authentication.
            </p>
          }
        >
          <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-12-regular">
            <dt class="text-text-weak">Environments</dt>
            <dd class="flex flex-wrap gap-1.5">
              <span class="rounded-full border border-border-weak-base px-2 py-px text-text-base">Local</span>
              <span class="rounded-full border border-border-weak-base px-2 py-px text-text-base">Cloud</span>
            </dd>
            <dt class="text-text-weak">Projects</dt>
            <dd class="text-text-base">
              <Show when={props.signed} fallback="Every project on this machine">
                {props.projectId
                  ? props.catalog.projects?.find((project) => project.id === props.projectId)?.label ?? props.projectId
                  : "Cross-project default"}
              </Show>
            </dd>
            <dt class="text-text-weak">Harnesses</dt>
            <dd class="flex flex-wrap gap-1.5">
              <For each={installedHarnesses(props.plugin)}>
                {(harness) => (
                  <span class="rounded-full border border-border-weak-base px-2 py-px text-text-base">{harness}</span>
                )}
              </For>
            </dd>
            <Show when={authentication()}>
              {(mode) => (
                <>
                  <dt class="text-text-weak">Authentication</dt>
                  <dd class="text-text-base">{mode()}</dd>
                </>
              )}
            </Show>
          </dl>
        </Show>
      </section>
    </aside>
  )
}
