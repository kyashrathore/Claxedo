import { For, Show, type Component } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import {
  TRANSCRIPT_PAIRINGS,
  TRANSCRIPT_PAIRING_KEYS,
  transcriptFaceFamily,
  type TranscriptPairing,
} from "@opencode-ai/ui/theme/transcript-typography"
import { useSettings } from "@/platform/settings/provider"
import { useTranscriptTypography } from "@/platform/settings/transcript-typography"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"

/** The account-menu row that shows or hides the panel; dev builds only, like the panel. */
export const RailTranscriptTypographyMenuItem: Component<{ open: boolean; onToggle: () => void }> = (props) => (
  <Show when={import.meta.env.DEV}>
    <DropdownMenu.Item data-action="settings-transcript-menu" onSelect={() => props.onToggle()}>
      <Icon name="document-text" size="small" />
      <DropdownMenu.ItemLabel class="flex-1">Transcript typography (dev)</DropdownMenu.ItemLabel>
      <Show when={props.open}>
        <span class="text-text-weak/50">&#10003;</span>
      </Show>
    </DropdownMenu.Item>
  </Show>
)

const ROW_CLASS =
  "w-full flex items-center gap-2 h-7 px-2.5 rounded-md text-compact leading-4 text-text-base/80 hover:text-text-base hover:bg-surface-base-hover/35 aria-checked:bg-surface-base-hover aria-checked:text-text-strong"

/**
 * Picks which transcript pairing the open transcript renders with: the active
 * theme's own, or one named here. Dev builds only, English only; the pairings
 * themselves are the catalogue in `@opencode-ai/ui/theme/transcript-typography`,
 * so a value that should ship is changed there, not here. It expands inside
 * the rail rather than Settings so the transcript re-renders beside each pick.
 */
export const RailTranscriptTypographyPanel: Component<{ onClose: () => void }> = (props) => {
  const settings = useSettings()
  const source = useTranscriptTypography()
  const chosen = () => source.setting().pairing
  const themeLabel = () => TRANSCRIPT_PAIRINGS[source.theme()?.pairing ?? "default"].label
  const row = (pairing: TranscriptPairing | undefined, label: string, detail?: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={chosen() === pairing}
      data-action={`settings-transcript-pairing-${pairing ?? "theme"}`}
      class={ROW_CLASS}
      style={{ "font-family": pairing ? transcriptFaceFamily(TRANSCRIPT_PAIRINGS[pairing].body) : undefined }}
      onClick={() => settings.appearance.setTranscriptPairing(pairing)}
    >
      <span class="min-w-0 flex-1 truncate text-left">{label}</span>
      <Show when={detail}>{(text) => <span class="min-w-0 truncate text-text-weak">{text()}</span>}</Show>
      <Show when={chosen() === pairing}>
        <span class="shrink-0 text-text-weak/50">&#10003;</span>
      </Show>
    </button>
  )
  return (
    <Show when={import.meta.env.DEV}>
      <section
        data-component="transcript-typography-panel"
        aria-label="Transcript typography (dev)"
        class="flex max-h-[55vh] shrink-0 flex-col border-t border-border-weak-base/15"
      >
        <div class="flex h-8 shrink-0 items-center gap-1 pl-5 pr-2.5">
          <span class="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-normal text-text-weaker">Typography (dev)</span>
          <IconButton
            icon="close-small"
            variant="ghost"
            class="h-6 w-6 rounded-md text-icon-weak-base hover:text-icon-base"
            data-action="settings-transcript-close"
            aria-label="Hide transcript typography"
            onClick={() => props.onClose()}
          />
        </div>
        <div role="radiogroup" aria-label="Transcript pairing" class="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2" style={{ "scrollbar-width": "thin" }}>
          {row(undefined, "Theme's", themeLabel())}
          <For each={TRANSCRIPT_PAIRING_KEYS}>{(pairing) => row(pairing, TRANSCRIPT_PAIRINGS[pairing].label)}</For>
        </div>
      </section>
    </Show>
  )
}
