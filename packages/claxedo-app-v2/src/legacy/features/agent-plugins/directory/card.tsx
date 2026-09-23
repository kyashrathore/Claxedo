import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Tag } from "@opencode-ai/ui/tag"
import type { PluginCandidate } from "../api"
import { PluginIconTile } from "./plugin-icon"
import { PluginStatusLine } from "./status"
import type { PersonalEntry } from "./view"
import { isBuiltIn, pluginLabel, type PluginStatus } from "./view"

/**
 * Every card is this tall so a section reads as a grid of equal rows. The body
 * holds exactly two lines — a name and one truncated line under it — and the
 * text lengths that would otherwise stretch a card (a long description, a long
 * status, a wrapping row of harness tags) are cut, not wrapped; the pane shows
 * them whole.
 */
const CARD = "flex h-16 items-start gap-3 rounded-lg border bg-surface-base p-3"

/** Sized by its content so the body keeps every pixel the slot does not need. */
const TRAILING = "relative flex max-w-[50%] shrink-0 justify-end pt-0.5"

/**
 * One directory card: tile, name, one line under it, one trailing slot.
 *
 * A path is an implementation detail of where the artifact lives, so it is
 * carried as the card's `title` and shown for real in the detail pane; the card
 * itself stays a product row.
 *
 * The whole card opens the detail pane through an overlay button so the primary
 * action stays a real button beside it instead of nesting one inside another.
 *
 * The built-in has nothing to install, so its trailing slot marks what it is,
 * and the line under its name is its status — which tool groups are on for this
 * project — rather than the description the pane repeats anyway.
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
  const builtIn = () => isBuiltIn(props.plugin)
  return (
    <div
      data-agent-plugin-card={props.plugin.pluginInstanceId}
      title={props.plugin.relativePath ?? undefined}
      class={`relative ${CARD} transition-colors hover:bg-surface-raised-base`}
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
      <PluginIconTile icon={props.plugin.icon} name={name()} builtIn={builtIn()} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-medium text-text-strong">{name()}</div>
        <Show
          when={builtIn() ? props.status : undefined}
          fallback={
            <p class="mt-0.5 truncate text-12-regular text-text-weak">
              {props.plugin.manifest?.description ?? "No description"}
            </p>
          }
        >
          {(status) => <div class="mt-0.5 flex"><PluginStatusLine status={status()} /></div>}
        </Show>
      </div>
      <div class={TRAILING}>
        <Show
          when={builtIn()}
          fallback={
            <Show when={props.action} fallback={<Show when={props.status}>{(status) => <PluginStatusLine status={status()} />}</Show>}>
              {(action) => (
                <Button size="small" variant="secondary" disabled={action().disabled} onClick={() => action().run()}>
                  {action().label}
                </Button>
              )}
            </Show>
          }
        >
          <Tag>Built in</Tag>
        </Show>
      </div>
    </div>
  )
}

/**
 * A Personal row: a plugin or a skill another harness installed. Informational,
 * no actions.
 *
 * The section title already says these are the user's own installs, so the row
 * carries only what distinguishes one from another — the harness it lives in,
 * whether it is a skill, and the marketplace a plugin came from. Its path is
 * the row's `title`.
 */
export function personalEntryKey(entry: PersonalEntry) {
  const marketplace = entry.kind === "plugin" ? entry.marketplace ?? "" : ""
  return `${entry.kind}:${entry.harnessId}:${marketplace}:${entry.name}`
}

const PERSONAL_TAG = "shrink-0 rounded-full border border-border-weak-base px-2 py-px text-11-medium"

export function PersonalCard(props: { entry: PersonalEntry; selected?: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-agent-plugin-personal={props.entry.name}
      aria-label={props.entry.name}
      aria-pressed={props.selected}
      title={props.entry.root}
      onClick={() => props.onOpen()}
      class={`${CARD} text-left ${props.selected ? "border-border-base" : "border-border-weak-base hover:border-border-base"}`}
    >
      <PluginIconTile name={props.entry.name} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-medium text-text-strong">{props.entry.name}</div>
        <div class="mt-1 flex gap-1.5 overflow-hidden">
          <span class={`${PERSONAL_TAG} text-text-weak`}>{props.entry.harnessId}</span>
          <Show when={props.entry.kind === "skill"}>
            <span class={`${PERSONAL_TAG} text-text-weaker`}>skill</span>
          </Show>
          <Show when={props.entry.kind === "plugin" ? props.entry.marketplace : undefined}>
            {(marketplace) => <span class={`${PERSONAL_TAG} text-text-weaker`}>{marketplace()}</span>}
          </Show>
        </div>
      </div>
    </button>
  )
}
