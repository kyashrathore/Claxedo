import { createMemo, type Accessor } from "solid-js"
import { useThemeOptional } from "@opencode-ai/ui/theme/context"
import {
  composeTranscriptTypography,
  DEFAULT_TRANSCRIPT_TYPOGRAPHY,
  type PairedTranscriptTypography,
} from "@opencode-ai/ui/theme/transcript-typography"

export function useTranscriptTypography(): Accessor<PairedTranscriptTypography> {
  const themes = useThemeOptional()
  const theme = createMemo(() => themes?.themes()[themes.themeId()]?.transcript)
  return createMemo(() => composeTranscriptTypography(DEFAULT_TRANSCRIPT_TYPOGRAPHY, theme()))
}
