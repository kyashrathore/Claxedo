export type WindowSize = { width: number; height: number }

/** Parses Claxedo's explicit window-size switch for deterministic window bounds. */
export function parseWindowSize(value: string): WindowSize | undefined {
  const match = /^(\d+),(\d+)$/u.exec(value.trim())
  if (!match) return
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return
  if (width < 320 || height < 240 || width > 16_384 || height > 16_384) return
  return { width, height }
}
