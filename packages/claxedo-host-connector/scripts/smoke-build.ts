import {
  enrollmentPayload,
  invitationRedeemPayload,
  publicKeyFingerprint,
  decodeInvitationToken,
} from "@claxedo/account-contract/machine"
const [connector, identity, hostState, hostStateNode, machineTransport, bootstrap] = await Promise.all([
  import("../dist/connector.mjs"),
  import("../dist/host-identity.mjs"),
  import("../dist/host-state.mjs"),
  import("../dist/host-state-node.mjs"),
  import("../dist/machine-transport.mjs"),
  import("../dist/bootstrap.mjs"),
])

for (const [name, value] of Object.entries({
  createHostConnector: connector.createHostConnector,
  createHostKeyPair: identity.createHostKeyPair,
  enrollmentPayload,
  hostKeyPairFromJwk: identity.hostKeyPairFromJwk,
  machineRequestSignature: identity.machineRequestSignature,
  invitationRedeemPayload,
  publicKeyFingerprint,
  decodeInvitationToken,
  createHostStateStore: hostState.createHostStateStore,
  effectiveRoots: hostState.effectiveRoots,
  resolveRoots: hostState.resolveRoots,
  nodeHostStateFs: hostStateNode.nodeHostStateFs,
  createMachineSignedTransport: machineTransport.createMachineSignedTransport,
  redeemInvitation: bootstrap.redeemInvitation,
})) {
  if (typeof value !== "function") throw new Error(`built Host Connector export is missing: ${name}`)
}

console.log("[host-connector] built entry smoke passed")
