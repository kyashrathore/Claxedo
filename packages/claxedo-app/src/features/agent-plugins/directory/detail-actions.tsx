import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type { AgentPluginHarness, PluginCandidate, PluginCatalog } from "../api"
import { OverflowItem, OverflowMenu } from "./overflow-menu"
import { defaultOutcome, isInstalled, pluginLabel } from "./view"

/**
 * The pane's action row: exactly one main button, everything else behind "…".
 *
 * "Add"/"Enable"/"Disable" is the only decision most visits make, so it is the
 * only thing that gets a button. Clearing an override, moving an organization
 * default and taking an update are all rarer and all destructive-ish, so they
 * live in the menu and name their consequence in full — the clear item computes
 * what the plugin would resolve to once the user's own choice is gone rather
 * than asking the user to work it out from the Status fact.
 *
 * Organization items are absent, not disabled, when the account cannot manage
 * them: a greyed-out row invites a support question, an absent one does not.
 */
export function PluginActions(props: {
  plugin: PluginCandidate
  signed: boolean
  catalog: PluginCatalog
  harnesses: readonly AgentPluginHarness[]
  pending: boolean
  onAdd: () => void
  onActivate: (choice: boolean | null) => void
  onUpdate: () => void
  onOrganizationDefault: (choice: true | null) => void
}) {
  const installed = () => isInstalled(props.plugin)
  const retained = () => Boolean(props.plugin.retainedDigest)
  const mutable = () => props.plugin.sourceAvailable || retained()
  const organizationDefaultEnabled = () => props.harnesses
    .some((harness) => props.plugin.harnesses[harness].organizationDefault)
  const organizationEligible = () => props.plugin.sourceKind === "claxedo"
    || props.plugin.sourceKind === "organization"
    || Object.values(props.plugin.harnesses).some((state) => state.organizationDefault)
  const canManageOrganization = () => props.signed
    && props.catalog.canManageOrganizationDefaults === true
    && organizationEligible()
  const outcome = () => defaultOutcome({ plugin: props.plugin, harnesses: props.harnesses })
  const version = () => props.plugin.manifest?.version

  return (
    <div class="flex items-center gap-1.5 px-4 py-3">
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

      <OverflowMenu label={`More actions for ${pluginLabel(props.plugin)}`}>
        <OverflowItem disabled={props.pending} onSelect={() => props.onActivate(null)}>
          {`Clear my override — follow the ${outcome().authority} default (would be ${outcome().enabled ? "enabled" : "disabled"})`}
        </OverflowItem>
        <Show when={canManageOrganization()}>
          <Show
            when={organizationDefaultEnabled()}
            fallback={
              <OverflowItem disabled={props.pending || !mutable()} onSelect={() => props.onOrganizationDefault(true)}>
                Make organization default (admin)
              </OverflowItem>
            }
          >
            <OverflowItem disabled={props.pending} onSelect={() => props.onOrganizationDefault(null)}>
              Remove organization default (admin)
            </OverflowItem>
          </Show>
        </Show>
        <Show when={props.plugin.updateAvailable}>
          <OverflowItem disabled={props.pending} onSelect={() => props.onUpdate()}>
            {version() ? `Update to ${version()}` : "Update to the latest version"}
          </OverflowItem>
        </Show>
      </OverflowMenu>
    </div>
  )
}
