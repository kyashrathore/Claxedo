import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type { PluginCandidate } from "../api"
import { PluginIconTile } from "./plugin-icon"
import { PluginStatusLine } from "./status"
import type { PersonalEntry } from "./view"
import { pluginLabel, type PluginStatus } from "./view"

/** The trailing column: one fixed slot, aligned to the title line, never centred. */
const TRAILING = "relative flex w-40 shrink-0 justify-end pt-0.5"

/**
 * One directory card: tile, name, one line of description, one trailing slot.
 *
 * A path is an implementation detail of where the artifact lives, so it is
 * carried as the card's `title` and shown for real in the detail pane; the card
 * itself stays a product row.
 *
 * The whole card opens the detail pane through an overlay button so the primary
 * action stays a real button beside it instead of nesting one inside another.
 */
export function DirectoryCard(props: {
  plugin: PluginCandidate
  status?: PluginStatus
  selected: boolean
  /** `undefined` once the plugin is installed; the status line speaks instead. */
  action?: { label: string; run: () => void; disabled?: boolean }
  onOpen: () => void
}) {
  const name = () => pluginLabel(props.plugin)
  return (
    <div
      data-agent-plugin-card={props.plugin.pluginInstanceId}
      title={props.plugin.relativePath ?? undefined}
      class="relative flex items-start gap-3 rounded-lg border bg-surface-base p-3 transition-colors hover:bg-surface-raised-base"
      classList={{
        "border-border-strong-base": props.selected,
        "border-border-weak-base": !props.selected,
      }}
    >
      <button
        type="button"
        data-directory-card-open
        aria-label={name()}
        aria-pressed={props.selected}
        class="absolute inset-0 rounded-lg"
        onClick={() => props.onOpen()}
      />
      <PluginIconTile icon={props.plugin.icon} name={name()} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-medium text-text-strong">{name()}</div>
        <p class="mt-0.5 line-clamp-2 text-12-regular text-text-weak">
          {props.plugin.manifest?.description ?? "No description"}
        </p>
      </div>
      <div class={TRAILING}>
        <Show when={props.action} fallback={<Show when={props.status}>{(status) => <PluginStatusLine status={status()} />}</Show>}>
          {(action) => (
            <Button size="small" variant="secondary" disabled={action().disabled} onClick={() => action().run()}>
              {action().label}
            </Button>
          )}
        </Show>
      </div>
    </div>
  )
}

/**
 * A Personal row: what another harness installed. Informational, no actions.
 *
 * The section title already says these are the user's own installs, so the row
 * carries only what distinguishes one from another — the harness it lives in
 * and the marketplace it came from. Its path is the row's `title`.
 */
export function PersonalCard(props: { entry: PersonalEntry }) {
  return (
    <div
      data-agent-plugin-personal={props.entry.name}
      title={props.entry.root}
      class="flex items-start gap-3 rounded-lg border border-border-weak-base bg-surface-base p-3"
    >
      <PluginIconTile name={props.entry.name} />
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2 pt-0.5">
        <span class="truncate text-13-medium text-text-strong">{props.entry.name}</span>
        <span class="shrink-0 rounded-full border border-border-weak-base px-2 py-px text-11-medium text-text-weak">
          {props.entry.harnessId}
        </span>
        <Show when={props.entry.marketplace}>
          {(marketplace) => (
            <span class="shrink-0 rounded-full border border-border-weak-base px-2 py-px text-11-medium text-text-weaker">
              {marketplace()}
            </span>
          )}
        </Show>
      </div>
    </div>
  )
}
