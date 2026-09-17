import { createMemo, type Accessor } from "solid-js"
import { useThemeOptional } from "@opencode-ai/ui/theme/context"
import {
  composeTranscriptTypography,
  type PairedTranscriptTypography,
  type TranscriptTypography,
} from "@opencode-ai/ui/theme/transcript-typography"
import { useSettings } from "@/platform/settings/provider"

export type TranscriptTypographySource = {
  /** What the transcript renders with: the stored choice composed over the active theme's. */
  typography: Accessor<PairedTranscriptTypography>
  /** The stored choice alone; an absent pairing means the theme's is in use. */
  setting: Accessor<TranscriptTypography>
  /** The active theme's own transcript choice, once its file has loaded. */
  theme: Accessor<PairedTranscriptTypography | undefined>
}

/**
 * The one place the user's transcript setting meets the theme. Themes load
 * lazily, so the theme's choice arrives a tick after the id changes and the
 * memo re-composes then; without a ThemeProvider (tests, isolated mounts) only
 * the setting counts.
 */
export function useTranscriptTypography(): TranscriptTypographySource {
  const settings = useSettings()
  const themes = useThemeOptional()
  const theme = createMemo(() => themes?.themes()[themes.themeId()]?.transcript)
  const typography = createMemo(() => composeTranscriptTypography(settings.appearance.transcript(), theme()))
  return { typography, setting: settings.appearance.transcript, theme }
}
