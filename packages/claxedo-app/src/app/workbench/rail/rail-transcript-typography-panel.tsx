import { Show, type Component } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { TRANSCRIPT_PAIRINGS } from "@opencode-ai/ui/theme/transcript-typography"
import { TranscriptTypographyKnobs } from "@opencode-ai/session-ui/transcript-typography-knobs"
import { useSettings } from "@/platform/settings/provider"
import { useTranscriptTypography } from "@/platform/settings/transcript-typography"
import { Tooltip } from "@opencode-ai/ui/tooltip"
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

/**
 * A knob for choosing the transcript typography that ships, not a product
 * setting: dev builds only, English only, and the chosen values are meant to
 * become the defaults in `@opencode-ai/ui/theme/transcript-typography` and
 * `session-ui/src/components/markdown.css`. It expands inside the rail rather
 * than Settings so the open transcript re-renders beside each pick.
 */
export const RailTranscriptTypographyPanel: Component<{
  onClose: () => void
  onMenuOpenChange: (open: boolean) => void
}> = (props) => {
  const settings = useSettings()
  const source = useTranscriptTypography()
  const transcript = source.setting
  const themed = () => Object.keys(transcript()).length === 0
  return (
    <Show when={import.meta.env.DEV}>
      <section
        data-component="transcript-typography-panel"
        aria-label="Transcript typography (dev)"
        class="flex max-h-[55vh] shrink-0 flex-col border-t border-border-weak-base/15"
      >
        <div class="flex h-8 shrink-0 items-center gap-1 pl-5 pr-2.5">
          <span class="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-normal text-text-weaker">Typography (dev)</span>
          <Tooltip placement="top" value="Back to the theme's">
            <IconButton
              icon="reset"
              variant="ghost"
              class="h-6 w-6 rounded-md text-icon-weak-base hover:text-icon-base"
              data-action="settings-transcript-reset"
              aria-label="Back to the theme's"
              disabled={themed()}
              onClick={() => settings.appearance.setTranscriptPairing(undefined)}
            />
          </Tooltip>
          <IconButton
            icon="close-small"
            variant="ghost"
            class="h-6 w-6 rounded-md text-icon-weak-base hover:text-icon-base"
            data-action="settings-transcript-close"
            aria-label="Hide transcript typography"
            onClick={() => props.onClose()}
          />
        </div>
        <div class="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2" style={{ "scrollbar-width": "thin" }}>
          <TranscriptTypographyKnobs
            value={transcript()}
            pairingDetail={`Theme · ${TRANSCRIPT_PAIRINGS[source.typography().pairing].label}`}
            onPairing={(pairing) => settings.appearance.setTranscriptPairing(pairing)}
            onOverride={(patch) => settings.appearance.setTranscriptOverride(patch)}
            onMenuOpenChange={props.onMenuOpenChange}
          />
        </div>
      </section>
    </Show>
  )
}
