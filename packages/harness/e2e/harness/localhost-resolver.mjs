// A sandboxed runtime may not reach the system resolver, so the signed stack's
// *.localhost public origin resolves to the loopback listener here, as
// Chromium resolves it without asking the system.
import dns from "node:dns"

const systemLookup = dns.lookup
dns.lookup = function lookup(hostname, options, callback) {
  const done = typeof options === "function" ? options : callback
  if (typeof hostname !== "string" || !hostname.endsWith(".localhost")) return systemLookup.apply(this, arguments)
  const all = typeof options === "object" && options !== null && options.all
  process.nextTick(() => all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4))
  return {}
}
