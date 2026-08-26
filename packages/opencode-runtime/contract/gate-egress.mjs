/**
 * Distinguishes an SDK defect from a sandbox artifact.
 *
 * `config.get`, `provider.list`, `model.list` and `integration.list` all
 * returned HTTP 500 here while session CRUD worked. Before recording that as an
 * SDK property, check whether this environment's own runtime can reach the
 * model catalog at all: Node's global fetch (undici) does not honor
 * HTTPS_PROXY without an explicit ProxyAgent, whereas curl does.
 *
 *   node gate-egress.mjs
 */
const target = "https://models.dev/api.json"

try {
  const response = await fetch(target)
  console.log("NODE_FETCH_STATUS", response.status)
} catch (error) {
  console.log("NODE_FETCH_ERR", error?.cause?.code ?? error?.code ?? String(error).slice(0, 160))
}

console.log("HTTPS_PROXY", process.env.HTTPS_PROXY ?? "unset")
console.log("NODE_EXTRA_CA_CERTS", process.env.NODE_EXTRA_CA_CERTS ?? "unset")
