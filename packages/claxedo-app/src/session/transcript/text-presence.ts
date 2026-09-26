import type { TranscriptPart } from "@/server"

const NON_BLANK = /\S/

export function textIsPresent(text: string): boolean {
  return NON_BLANK.test(text)
}

export function partHasText(part: TranscriptPart): boolean {
  return "text" in part && typeof part.text === "string" && textIsPresent(part.text)
}
