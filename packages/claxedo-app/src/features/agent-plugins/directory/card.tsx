import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type { PluginCandidate } from "../api"
import { PluginIconTile } from "./plugin-icon"
import { StateChip } from "./state-chip"
import type { PersonalEntry } from "./view"
import { pluginLabel, type DirectoryStateChip } from "./view"

/**
 * One directory card.
 *
 * The whole card opens the detail pane through an overlay button so the primary
 * action stays a real button beside it instead of nesting one inside another.
 */
export function DirectoryCard(props: {
  plugin: PluginCandidate
  chip?: DirectoryStateChip
  selected: boolean
  /** `undefined` while a mutation for this plugin is in flight. */
  action?: { label: string; run: () => void; disabled?: boolean }
  onOpen: () => void
}) {
  const name = () => pluginLabel(props.plugin)
  return (
    <div
      data-agent-plugin-card={props.plugin.pluginInstanceId}
      class="relative grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border bg-surface-base p-3 hover:bg-surface-raised-base"
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
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="truncate text-13-medium text-text-strong">{name()}</span>
          <Show when={props.chip}>{(chip) => <StateChip chip={chip()} />}</Show>
        </div>
        <p class="truncate text-12-regular text-text-weak">
          {props.plugin.manifest?.description ?? props.plugin.relativePath ?? "No description"}
        </p>
      </div>
      <div class="relative shrink-0">
        <Show
          when={props.action}
          fallback={<span class="text-12-medium text-icon-success-base">Installed ✓</span>}
        >
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

/** A Personal row: what another harness installed. Informational, no actions. */
export function PersonalCard(props: { entry: PersonalEntry }) {
  return (
    <div
      data-agent-plugin-personal={props.entry.name}
      class="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-border-weak-base bg-surface-base p-3"
    >
      <PluginIconTile name={props.entry.name} />
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="truncate text-13-medium text-text-strong">{props.entry.name}</span>
          <span class="shrink-0 rounded-full border border-border-weak-base px-2 py-px text-11-medium text-text-weak">
            {props.entry.harnessId}
          </span>
        </div>
        <p class="truncate text-12-mono text-text-weak">{props.entry.root}</p>
      </div>
      <span class="shrink-0 text-12-regular text-text-weaker">Installed by you</span>
    </div>
  )
}
