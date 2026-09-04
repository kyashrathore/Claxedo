import { Show } from "solid-js"
import { PluginIconTile } from "./plugin-icon"
import type { PersonalEntry } from "./view"

const HARNESS_LABEL: Record<PersonalEntry["harnessId"], string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
}

/**
 * What the Directory can say about a plugin another harness installed: where
 * it lives and who manages it. Claxedo does not own it, so there is nothing
 * to enable or disable here — the harness that installed it does that.
 */
export function PersonalPane(props: { entry: PersonalEntry; onClose: () => void }) {
  return (
    <aside
      aria-label={`${props.entry.name} details`}
      class="flex h-full min-h-0 flex-col overflow-auto border-l border-border-weak-base bg-surface-base"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); props.onClose() } }}
    >
      <header class="grid grid-cols-[3rem_1fr_auto] items-start gap-3 border-b border-border-weak-base p-4">
        <PluginIconTile name={props.entry.name} size="pane" />
        <div class="min-w-0">
          <h3 class="truncate text-14-medium text-text-strong">{props.entry.name}</h3>
          <p class="text-12-regular text-text-weak">
            {props.entry.version ? `v${props.entry.version} · ` : ""}installed by {HARNESS_LABEL[props.entry.harnessId]}
          </p>
        </div>
        <button type="button" aria-label="Close" onClick={() => props.onClose()} class="rounded px-1.5 text-text-weak hover:bg-surface-base-hover hover:text-text-strong">×</button>
      </header>
      <dl class="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3 gap-y-1.5 border-b border-border-weak-base px-4 py-3 text-12-regular">
        <dt class="text-text-weak">Harness</dt><dd class="text-text-base">{HARNESS_LABEL[props.entry.harnessId]}</dd>
        <Show when={props.entry.marketplace}>{(marketplace) => <><dt class="text-text-weak">Marketplace</dt><dd class="text-text-base">{marketplace()}</dd></>}</Show>
        <dt class="text-text-weak">Location</dt><dd class="break-all text-12-mono text-text-base">{props.entry.root}</dd>
      </dl>
      <p class="px-4 py-3 text-12-regular text-text-weak">
        {HARNESS_LABEL[props.entry.harnessId]} manages this plugin. Enable or remove it there; Claxedo lists it so you can see what each harness already carries.
      </p>
    </aside>
  )
}
