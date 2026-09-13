import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type { AgentPluginHarness, PluginCandidate, PluginCatalog } from "../api"
import { OverflowItem, OverflowMenu } from "./overflow-menu"
import { defaultOutcome, isBuiltIn, isInstalled, pluginLabel } from "./view"

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
 *
 * The built-in has no artifact to add, take or hand to an organization, so it
 * reaches only the main button and the one item that gives the decision back
 * to the defaults. Its off state is restored rather than enabled: turning every
 * group on would turn Tasks on, and the deployment default leaves it off, so a
 * button saying "Enable" would hand back six groups of eight and read as a bug.
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
  const builtIn = () => isBuiltIn(props.plugin)
  /** Nothing left to acquire before enabling: bytes already retained, or the product itself. */
  const acquired = () => builtIn() || Boolean(props.plugin.retainedDigest)
  const mutable = () => props.plugin.sourceAvailable || acquired()
  const organizationDefaultEnabled = () => props.harnesses
    .some((harness) => props.plugin.harnesses[harness].organizationDefault)
  const organizationEligible = () => props.plugin.sourceKind === "claxedo"
    || props.plugin.sourceKind === "organization"
    || Object.values(props.plugin.harnesses).some((state) => state.organizationDefault)
  const canManageOrganization = () => props.signed
    && !builtIn()
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
            when={acquired()}
            fallback={
              <Button size="small" variant="primary" disabled={props.pending || !mutable()} onClick={() => props.onAdd()}>
                Add
              </Button>
            }
          >
            <Button size="small" variant="primary" disabled={props.pending || !mutable()} onClick={() => props.onActivate(true)}>
              {props.pending ? "Applying…" : builtIn() ? "Restore defaults" : "Enable"}
            </Button>
          </Show>
        }
      >
        <Button size="small" variant="secondary" disabled={props.pending || !mutable()} onClick={() => props.onActivate(false)}>
          {props.pending ? "Applying…" : "Disable"}
        </Button>
      </Show>

      <OverflowMenu label={`More actions for ${pluginLabel(props.plugin)}`}>
        <Show
          when={builtIn()}
          fallback={
            <OverflowItem
              disabled={props.pending}
              onSelect={() => props.onActivate(null)}
              hint={`Follow the ${outcome().authority} default — it would be ${outcome().enabled ? "enabled" : "disabled"}`}
            >
              Clear my override
            </OverflowItem>
          }
        >
          <OverflowItem
            disabled={props.pending}
            onSelect={() => props.onActivate(null)}
            hint="Every group goes back to its default"
          >
            Restore defaults
          </OverflowItem>
        </Show>
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
        <Show when={!builtIn() && props.plugin.updateAvailable}>
          <OverflowItem disabled={props.pending} onSelect={() => props.onUpdate()}>
            {version() ? `Update to ${version()}` : "Update to the latest version"}
          </OverflowItem>
        </Show>
      </OverflowMenu>
    </div>
  )
}
