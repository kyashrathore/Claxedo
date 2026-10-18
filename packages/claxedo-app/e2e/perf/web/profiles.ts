export const PROFILE_NAMES = ["none", "fast", "india-staging"] as const

export type ProfileName = (typeof PROFILE_NAMES)[number]

/**
 * `Network.emulateNetworkConditions` adds `latencyMs` once per request before
 * its headers can arrive and caps throughput; it does not replay a handshake
 * per round trip. The front's own delays stack on top for the request classes
 * Chromium cannot tell apart: the API is one extra `apiDelayMs` on every
 * control-plane answer, so an API answer waits `latencyMs + apiDelayMs`.
 */
export type Profile = {
  readonly name: ProfileName
  readonly latencyMs: number
  readonly downloadBytesPerSecond: number
  readonly uploadBytesPerSecond: number
  readonly apiDelayMs: number
}

const MBPS = 1_000_000 / 8

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  none: { name: "none", latencyMs: 0, downloadBytesPerSecond: -1, uploadBytesPerSecond: -1, apiDelayMs: 0 },
  fast: { name: "fast", latencyMs: 20, downloadBytesPerSecond: 100 * MBPS, uploadBytesPerSecond: 50 * MBPS, apiDelayMs: 0 },
  "india-staging": { name: "india-staging", latencyMs: 100, downloadBytesPerSecond: 10 * MBPS, uploadBytesPerSecond: 5 * MBPS, apiDelayMs: 200 },
}

export function describeProfile(profile: Profile) {
  if (profile.name === "none") return "the host's own network"
  const mbps = (bytes: number) => `${Math.round((bytes * 8) / 1_000_000)} Mbps`
  return `${profile.latencyMs} ms to static, ${profile.latencyMs + profile.apiDelayMs} ms to the API, ${mbps(profile.downloadBytesPerSecond)} down, ${mbps(profile.uploadBytesPerSecond)} up`
}
