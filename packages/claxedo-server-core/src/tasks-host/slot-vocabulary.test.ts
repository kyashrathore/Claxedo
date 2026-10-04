/**
 * A preset configures one slot per session in a started group, so the kit's
 * `CONFIGURATION_SLOTS` and the runtime contract's `SESSION_GROUP_SLOTS` are
 * one vocabulary written twice: `startModelGroup` maps a preset's
 * configurations straight onto the group the session-create body carries.
 *
 * Neither package may depend on the other — the kit is an optional catalog and
 * the contract is the runtime's own — and this host is the one place that
 * reaches both, so the drift fails here or nowhere.
 */
import { SESSION_GROUP_SLOTS } from "@claxedo/agent-runtime-contract"
import { CONFIGURATION_SLOTS } from "@claxedo/tasks"
import { expect, test } from "vitest"

test("a preset's configuration slots are the runtime's session-group slots", () => {
  expect([...CONFIGURATION_SLOTS]).toEqual([...SESSION_GROUP_SLOTS])
})
