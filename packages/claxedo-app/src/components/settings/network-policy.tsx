/**
 * Network Policy Settings — manage outbound egress allowlists.
 *
 * Custom entries shown inline. Default allowlist behind a link
 * that opens an inline fixed overlay (not a Portal — stays inside
 * Kobalte's dialog tree so it doesn't trigger parent dismiss).
 */

import { createSignal, createMemo, createResource, For, Show, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { usePlatform } from "@opencode-ai/claxedo-app"
import { useGlobalSDK } from "@/context/global-sdk"
import { can } from "../shell/auth/role"
import { placementFromWorkspaceConnection } from "../shell/auth/placement"
import { openWorkspaceConnection } from "../utils/workspace-relay-connection"
import {
  networkPolicyCreateBody,
  networkPolicyGroupsUrl,
  networkPolicyRowsUrl,
  networkPolicyRowUrl,
  parsePolicyEntries,
  parsePolicyGroups,
  policyEntryLabel,
  policyKindFromValue,
  shouldUseNetworkPolicyRows,
  type NetworkPolicyGroups,
  type PolicyKind,
} from "./network-policy-settings-helpers"

/**
 * Inline fixed overlay — NOT a Portal, so it stays inside Kobalte's
 * dialog DOM tree and doesn't trigger parent dialog dismiss.
 */
function DefaultAllowlistOverlay(props: { groups: NetworkPolicyGroups; onClose: () => void }) {
  const entries = Object.entries(props.groups)
  const totalHosts = entries.reduce((sum, [, hosts]) => sum + hosts.length, 0)
  let ref: HTMLDivElement | undefined

  // Trap Escape inside this overlay
  onMount(() => {
    ref?.focus()
  })

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      props.onClose()
    }
  }

  return (
    <div
      ref={(el) => {
        ref = el
      }}
      tabIndex={-1}
      class="fixed inset-0 z-[100] flex items-center justify-center outline-none"
      style={{ "background-color": "rgba(0,0,0,0.5)" }}
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}
    >
      <div
        class="w-full max-w-[560px] mx-4 rounded-lg border border-border-base shadow-xl flex flex-col max-h-[70vh]"
        style={{ "background-color": "var(--surface-raised-base, #1e1e1e)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between px-5 py-4 border-b border-border-weak-base shrink-0">
          <h3 class="text-14-medium text-text-strong">Default Allowlist</h3>
          <button
            type="button"
            aria-label="Close default allowlist"
            class="text-icon-weak-base hover:text-icon-base transition-colors p-1 rounded"
            onClick={() => props.onClose()}
          >
            <Icon name="close" size="small" />
          </button>
        </div>
        <div class="flex flex-col gap-4 px-5 py-4 overflow-y-auto no-scrollbar">
          <p class="text-12-regular text-text-weak">
            {totalHosts} hosts across {entries.length} groups. Always active for all sandboxes.
          </p>
          <For each={entries}>
            {([name, hosts]) => (
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center gap-2">
                  <span class="text-13-medium text-text-strong">{name}</span>
                  <span class="text-11-regular text-text-weaker">{hosts.length}</span>
                </div>
                <div class="flex flex-wrap gap-1">
                  <For each={hosts}>
                    {(host) => (
                      <span class="text-[11px] font-mono text-text-weaker bg-surface-inset-base px-1.5 py-0.5 rounded">
                        {host}
                      </span>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}

export function NetworkPolicySettings(props: { workspaceId?: string }) {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const request = platform.fetch ?? globalThis.fetch
  const base = sdk.url

  const [newTarget, setNewTarget] = createSignal("")
  const [newKind, setNewKind] = createSignal<PolicyKind>("host")
  const [saving, setSaving] = createSignal(false)
  const [showDefaults, setShowDefaults] = createSignal(false)
  const workspaceScope = () => props.workspaceId?.trim() || undefined

  const shouldLoadPolicyRows = () => shouldUseNetworkPolicyRows({
    baseUrl: base,
    workspaceId: props.workspaceId,
  })

  const [workspacePlacement] = createResource(workspaceScope, async (workspaceId) =>
    await openWorkspaceConnection(workspaceId, { serverUrl: base, request })
      .then(placementFromWorkspaceConnection)
      .catch(() => undefined)
  )

  const canWritePolicy = createMemo(() => !workspaceScope() || can("mutate.workspace", workspacePlacement()))

  const [policies, { refetch }] = createResource(
    () => ({ enabled: shouldLoadPolicyRows(), workspaceId: props.workspaceId }),
    async (scope) => {
      if (!scope.enabled) return []
      const res = await request(networkPolicyRowsUrl(base, scope.workspaceId))
      if (!res.ok) return []
      return parsePolicyEntries(await res.json().catch(() => undefined))
    },
  )

  const [groups] = createResource(async () => {
    const res = await request(networkPolicyGroupsUrl(base))
    if (!res.ok) return {}
    return parsePolicyGroups(await res.json().catch(() => undefined))
  })

  async function addEntry() {
    if (!shouldLoadPolicyRows()) return
    if (!canWritePolicy()) return
    const target = newTarget().trim()
    if (!target) return
    setSaving(true)
    try {
      const res = await request(networkPolicyRowsUrl(base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(networkPolicyCreateBody({ workspaceId: props.workspaceId, target, kind: newKind() })),
      })
      if (res.ok) {
        setNewTarget("")
        await refetch()
      }
    } finally {
      setSaving(false)
    }
  }

  async function removeEntry(id: string) {
    if (!shouldLoadPolicyRows()) return
    if (!canWritePolicy()) return
    const res = await request(networkPolicyRowUrl(base, id), { method: "DELETE" })
    if (res.ok) {
      await refetch()
    }
  }

  const totalDefaultHosts = () => {
    const g = groups()
    if (!g) return 0
    return Object.values(g).reduce((sum, hosts) => sum + hosts.length, 0)
  }

  return (
    <div class="flex flex-col gap-3">
      {/* Default allowlist link */}
      <p class="text-12-regular text-text-weak">
        All sandboxes include a{" "}
        <button
          type="button"
          class="text-text-interactive-base hover:underline cursor-pointer"
          onClick={() => setShowDefaults(true)}
        >
          default allowlist ({totalDefaultHosts()} hosts)
        </button>
        {" "}for package registries, git, AI APIs, and common services.
      </p>

      {/* Default allowlist overlay — rendered inline, not Portal */}
      <Show when={showDefaults() && groups()}>
        <DefaultAllowlistOverlay groups={groups()!} onClose={() => setShowDefaults(false)} />
      </Show>

      <Show when={shouldLoadPolicyRows()}>
        <Show when={workspaceScope() && !canWritePolicy()}>
          <p class="text-12-regular text-text-weak">Only workspace admins and owners can edit network policy.</p>
        </Show>

        {/* Custom entries */}
        <Show when={(policies() ?? []).length > 0}>
          <div class="flex flex-col gap-0.5">
            <For each={policies()}>
              {(entry) => {
                const label = policyEntryLabel(entry)
                return (
                  <div class="flex items-center justify-between px-2 py-1 rounded bg-surface-inset-base">
                    <div class="flex items-center gap-2">
                      <span class="text-13-regular text-text-strong">{label}</span>
                      <Show when={label !== entry.target}>
                        <span class="text-11-regular font-mono text-text-weaker">{entry.target}</span>
                      </Show>
                      <Show when={entry.kind === "domain"}>
                        <span class="text-[10px] px-1 py-0.5 rounded bg-surface-base text-text-weaker">wildcard</span>
                      </Show>
                      <Show when={entry.kind === "group"}>
                        <span class="text-[10px] px-1 py-0.5 rounded bg-surface-base text-text-weaker">group</span>
                      </Show>
                      <Show when={entry.constraints.auto}>
                        <span class="text-[10px] px-1 py-0.5 rounded bg-surface-base text-text-weaker">auto</span>
                      </Show>
                    </div>
                    <Show when={!entry.constraints.auto}>
                      <button
                        type="button"
                        aria-label={`Remove ${label}`}
                        class="text-icon-weak-base hover:text-icon-critical-base transition-colors p-1"
                        onClick={() => void removeEntry(entry.id)}
                        disabled={!canWritePolicy()}
                      >
                        <Icon name="close" size="small" />
                      </button>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        {/* Add new entry */}
        <div class="flex items-center gap-2">
          <select
            class="text-12-regular bg-surface-inset-base border border-border-base rounded px-2 py-1.5 text-text-strong"
            value={newKind()}
            onChange={(e) => setNewKind(policyKindFromValue(e.currentTarget.value))}
          >
            <option value="host">Host</option>
            <option value="domain">Domain</option>
            <option value="group">Group</option>
          </select>
          <Show when={newKind() === "group"}>
            <select
              class="flex-1 text-12-regular bg-surface-inset-base border border-border-base rounded px-2 py-1.5 text-text-strong"
              value={newTarget()}
              onChange={(e) => setNewTarget(e.currentTarget.value)}
            >
              <option value="">Select a group...</option>
              <For each={Object.keys(groups() ?? {})}>
                {(name) => <option value={name}>{name} ({(groups() ?? {})[name]?.length ?? 0} hosts)</option>}
              </For>
            </select>
          </Show>
          <Show when={newKind() !== "group"}>
            <input
              class="flex-1 text-12-regular bg-surface-inset-base border border-border-base rounded px-2 py-1.5 text-text-strong"
              placeholder={newKind() === "domain" ? "*.example.com" : "api.example.com"}
              value={newTarget()}
              onInput={(e) => setNewTarget(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addEntry()
              }}
            />
          </Show>
          <Button size="small" variant="secondary" onClick={() => void addEntry()} disabled={!canWritePolicy() || !newTarget().trim() || saving()}>
            Add
          </Button>
        </div>
      </Show>
    </div>
  )
}
