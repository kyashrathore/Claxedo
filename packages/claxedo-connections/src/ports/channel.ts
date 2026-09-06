import type { TokenPort } from "./serving.js"

/**
 * `channel` — the place a person is reachable for an update or an approval.
 *
 * Token-served.
 */
export type ChannelPort = TokenPort<"channel">

export const channelPort: ChannelPort = { capability: "channel" }
