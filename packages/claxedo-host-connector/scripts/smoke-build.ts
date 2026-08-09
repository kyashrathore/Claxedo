const [connector, identity] = await Promise.all([
  import("../dist/connector.mjs"),
  import("../dist/host-identity.mjs"),
])

for (const [name, value] of Object.entries({
  createHostConnector: connector.createHostConnector,
  createHostKeyPair: identity.createHostKeyPair,
  enrollmentPayload: identity.enrollmentPayload,
  heartbeatPayload: identity.heartbeatPayload,
  hostKeyPairFromJwk: identity.hostKeyPairFromJwk,
})) {
  if (typeof value !== "function") throw new Error(`built Host Connector export is missing: ${name}`)
}

console.log("[host-connector] built entry smoke passed")
