import { createMemo, type Accessor } from "solid-js"
import { useThemeOptional } from "@/ui"
import { composeTranscriptTypography, DEFAULT_TRANSCRIPT_TYPOGRAPHY, type PairedTranscriptTypography } from "@/ui/utils"

export function useTranscriptTypography(): Accessor<PairedTranscriptTypography> {
  const themes = useThemeOptional()
  const theme = createMemo(() => themes?.themes()[themes.themeId()]?.transcript)
  return createMemo(() => composeTranscriptTypography(DEFAULT_TRANSCRIPT_TYPOGRAPHY, theme()))
}
