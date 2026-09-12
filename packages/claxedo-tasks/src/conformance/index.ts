// Runner-neutral store-port conformance. Each case is a plain async function,
// so any host adapter — the memory store here, SQLite and D1 in the server
// packages — registers the same cases with its own test runner.
export {
  CONFORMANCE_SCOPES,
  TASKS_STORE_CONFORMANCE_SCOPE,
  TASKS_STORE_CONFORMANCE_VERSION,
  tasksStoreConformance,
  type TasksStoreConformanceCase,
  type TasksStoreConformanceFactory,
} from "./store"
