export type ListOrderKey = {
  readonly updatedAt: number
  readonly createdAt: number
  readonly lastHumanTurnAt?: number
  readonly sessionRef: string
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function listOrderKey(item: unknown): ListOrderKey | undefined {
  if (!item || typeof item !== "object") return undefined
  const row = item as Record<string, unknown>
  const createdAt = number(row.createdAt)
  const updatedAt = number(row.updatedAt)
  const lastHumanTurnAt = number(row.lastHumanTurnAt)
  if (createdAt === undefined || updatedAt === undefined || typeof row.sessionRef !== "string") return undefined
  return { updatedAt, createdAt, ...(lastHumanTurnAt === undefined ? {} : { lastHumanTurnAt }), sessionRef: row.sessionRef }
}

export function compareListOrder(a: ListOrderKey, b: ListOrderKey): number {
  const activity = (b.lastHumanTurnAt ?? 0) - (a.lastHumanTurnAt ?? 0)
  if (activity !== 0) return activity
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  if (a.sessionRef === b.sessionRef) return 0
  return a.sessionRef < b.sessionRef ? 1 : -1
}

export function encodeListAfter(key: ListOrderKey): string {
  const bytes = new TextEncoder().encode(JSON.stringify(key))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}
