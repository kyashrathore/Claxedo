import { TRANSCRIPT_NUMBERS, type ResolvedTranscriptTypography } from "@/ui/utils"

export type TranscriptViewport = { readonly rows: number; readonly cols: number }

const COLUMN_MAX_PX = 768
const COLUMN_PADDING_PX = 40
const PROSE_CHAR_EM = 0.55
const MAX_EXTENT = 2000

type BodyType = Partial<Pick<ResolvedTranscriptTypography, "fontSize" | "lineHeight">>

export function transcriptViewport(size: { readonly width: number; readonly height: number }, type: BodyType = {}): TranscriptViewport {
  const fontSize = type.fontSize ?? TRANSCRIPT_NUMBERS.fontSize.shipped
  const lineHeight = type.lineHeight ?? TRANSCRIPT_NUMBERS.lineHeight.shipped
  const extent = (value: number) => Math.min(MAX_EXTENT, Math.max(1, value))
  return {
    rows: extent(Math.ceil(size.height / (fontSize * lineHeight))),
    cols: extent(Math.floor((Math.min(size.width, COLUMN_MAX_PX) - COLUMN_PADDING_PX) / (fontSize * PROSE_CHAR_EM))),
  }
}
