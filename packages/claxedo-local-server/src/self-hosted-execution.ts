/**
 * The desktop daemon's entry: start the local server, run its lifecycle and
 * publish its ownership, so no consumer reaches this package's internal
 * layout. It names nothing about Electron, any hosted capability, or who is
 * signed in.
 */

export { startLocalServer } from "./app/start-local-server"
export { createLocalDaemonLifecycle } from "./app/local-daemon-lifecycle"
export { localDaemonOperationStore } from "./app/daemon-operation-store"
export {
  claxedoDaemonOwnershipPath,
  clearDaemonOwnershipSnapshot,
  createDaemonOwnershipPublisher,
} from "./app/daemon-ownership-snapshot"

/** Verified caller stamping for a machine request the channels dispatch forwards. */
export { embeddedRelayHostAuthFromActor, EMBEDDED_RELAY_HOST_AUTH_HEADER } from "./workspace/runtime-dispatch/embedded-relay-host-auth"
