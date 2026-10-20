// Paste into the console of a signed-in staging tab (https://app.claxedo.dev). It fetches the boot's
// signed reads in rounds, a second apart, and prints each answer's Server-Timing `auth`, `d1` and
// `total`, then the medians of the answers that verified the cookie live (`auth` above 1 ms) and of
// the ones the principal cache admitted. The first round after more than 60 s of quiet is live and
// sets the cache; the rest should be admitted. `await measureSessionCache({ gapMs: 61_000 })` shows
// every round going live.
globalThis.measureSessionCache = async ({ rounds = 10, gapMs = 1_000 } = {}) => {
  const routes = [
    "/api/workspace/shared-sessions",
    "/api/control/session-list?scope=projects",
    "/api/claxedo/remote-access/devices",
    "/api/claxedo/agent-config/connections",
    "/api/claxedo/auth/profile",
  ]
  const timing = (header, name) => Number(new RegExp(`(?:^|, )${name};dur=([0-9.]+)`).exec(header ?? "")?.[1] ?? NaN)
  const rows = []
  for (let round = 0; round < rounds; round += 1) {
    for (const route of routes) {
      const response = await fetch(route, { credentials: "same-origin", cache: "no-store" })
      const header = response.headers.get("server-timing")
      rows.push({ round, route, status: response.status, auth: timing(header, "auth"), d1: timing(header, "d1"), total: timing(header, "total") })
    }
    if (round < rounds - 1) await new Promise((resolve) => setTimeout(resolve, gapMs))
  }
  console.table(rows)
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN
  }
  const summary = (picked) => ({ n: picked.length, auth: median(picked.map((row) => row.auth)), d1: median(picked.map((row) => row.d1)), total: median(picked.map((row) => row.total)) })
  console.table({ live: summary(rows.filter((row) => row.auth > 1)), cached: summary(rows.filter((row) => row.auth <= 1)) })
}
await measureSessionCache()
