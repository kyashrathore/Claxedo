import type { ChannelId } from "@claxedo/channels"

export { channelFromThreadKey } from "@claxedo/channels"

/**
 * The ONE place a `ChannelId` is recovered from stored or request-supplied text.
 *
 * `control-plane.ts` already had this check written out as a chained `||`, but
 * three other readers — a SQLite access row, a run-audit row, and the
 * `?channel=` query parameter — reached the same type by `as ChannelId`
 * instead, which meant a row written before a channel was removed, or a
 * hand-typed query string, arrived downstream typed as a supported channel.
 */
const CHANNEL_IDS: readonly ChannelId[] = ["github", "slack", "telegram", "discord", "whatsapp"]

export function channelId(input: unknown): ChannelId | undefined {
  return CHANNEL_IDS.find((id) => id === input)
}
