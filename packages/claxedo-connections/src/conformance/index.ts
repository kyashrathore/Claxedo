// Runner-neutral store-port conformance. Each case is a plain async function,
// so any host adapter — memory here, SQLite in claxedo-server — registers the
// same cases with its own test runner.
export {
  CONFORMANCE_OWNERS,
  CONNECTION_STORE_CONFORMANCE_SCOPE,
  CONNECTION_STORE_CONFORMANCE_VERSION,
  connectionStoreConformance,
  connectionStoreCoreConformance,
  connectionStorePartitionConformance,
  type ConnectionStoreConformanceCase,
  type ConnectionStoreConformanceFactory,
  type ConnectionStoreCoreConformanceFactory,
} from "./connection-store.js"
export {
  CREDENTIAL_STORE_CONFORMANCE_SCOPE,
  CREDENTIAL_STORE_CONFORMANCE_VERSION,
  credentialStoreConformance,
  type CredentialStoreConformanceCase,
  type CredentialStoreConformanceFactory,
} from "./credential-store.js"
