import { isNonNegativeSafeInteger } from "@claxedo/helpers/guards"

export type SessionAttentionPageQuery = { after: number; limit: number }

export function parseSessionAttentionPageQuery(input: { after?: string; limit?: string }): SessionAttentionPageQuery | undefined {
  const after = sessionAttentionQueryInteger(input.after, 0)
  const limit = sessionAttentionQueryInteger(input.limit, 256)
  return after !== undefined && limit !== undefined && limit >= 1 && limit <= 256 ? { after, limit } : undefined
}

function sessionAttentionQueryInteger(input: string | undefined, omitted: number): number | undefined {
  if (input === undefined) return omitted
  if (!/^\d+$/.test(input)) return undefined
  const value = Number(input)
  return isNonNegativeSafeInteger(value) ? value : undefined
}
