import { Show } from "solid-js"
import { PluginIconTile } from "./plugin-icon"
import type { PersonalEntry } from "./view"

const HARNESS_LABEL: Record<PersonalEntry["harnessId"], string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  opencode: "OpenCode",
  agents: "AGENTS.md harnesses",
}

/**
 * What the Directory can say about a plugin or skill another harness installed:
 * where it lives and who manages it. Claxedo does not own it, so there is
 * nothing to enable, disable or delete here — the harness that installed it
 * does that, and this pane never offers to touch the files on disk.
 */
export function PersonalPane(props: { entry: PersonalEntry; onClose: () => void }) {
  const harness = () => HARNESS_LABEL[props.entry.harnessId]
  const noun = () => (props.entry.kind === "skill" ? "skill" : "plugin")
  const version = () => (props.entry.kind === "plugin" ? props.entry.version : undefined)
  const marketplace = () => (props.entry.kind === "plugin" ? props.entry.marketplace : undefined)
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
            {version() ? `v${version()} · ` : ""}installed by {harness()}
          </p>
        </div>
        <button type="button" aria-label="Close" onClick={() => props.onClose()} class="rounded px-1.5 text-text-weak hover:bg-surface-base-hover hover:text-text-strong">×</button>
      </header>
      <dl class="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3 gap-y-1.5 border-b border-border-weak-base px-4 py-3 text-12-regular">
        <dt class="text-text-weak">Harness</dt><dd class="text-text-base">{harness()}</dd>
        <dt class="text-text-weak">Kind</dt><dd class="text-text-base">{noun()}</dd>
        <Show when={marketplace()}>{(value) => <><dt class="text-text-weak">Marketplace</dt><dd class="text-text-base">{value()}</dd></>}</Show>
        <dt class="text-text-weak">Location</dt><dd class="break-all text-12-mono text-text-base">{props.entry.root}</dd>
      </dl>
      <p class="px-4 py-3 text-12-regular text-text-weak">
        {harness()} manages this {noun()}. Enable or remove it there; Claxedo lists it so you can see what each harness already carries.
      </p>
    </aside>
  )
}
