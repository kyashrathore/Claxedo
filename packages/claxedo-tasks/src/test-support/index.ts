// What a test outside this package needs to stand the kit up: record builders,
// port fakes, and the in-memory reference adapter. `./conformance` is the other
// test-only door and carries the cases an adapter must pass; neither is
// reachable from the production entry.
export { createMemoryTasksStore } from "../stores/memory"
export {
  OWNER,
  SCOPES,
  linkRow,
  presetDraft,
  presetRow,
  primaryConfiguration,
  receiptRow,
  slotted,
  taskRow,
} from "./rows"
export {
  ACTOR,
  HARNESSES,
  OTHER_ACTOR,
  OTHER_SCOPE,
  fakeAuthorization,
  fakeBridge,
  fakeCapabilities,
  fakeClock,
  fakeIds,
  type FakeAuthorization,
  type FakeBridge,
} from "./fakes"
export { fieldReasons, parsedReasons, refusalOf } from "./refusals"
