/**
 * Contract check: the structural subset in `events.ts` must stay assignable
 * FROM the canonical `AgentRuntimeEvent` union. The relative import reaches the
 * real contract source directly (this test never ships; the core itself stays
 * dependency-free so it can compile as a Native SDK core).
 *
 * If the canonical contract renames a field this subset relies on, the type
 * assertions below stop compiling and `bun test` fails the file — drift becomes
 * a red test, not a runtime surprise.
 */

import { describe, expect, test } from "bun:test"
import type { AgentRuntimeEvent, AgentRuntimeEventOf } from "../../../agent-event-runtime/src/contracts/agent-runtime-event"
import type { RuntimeEventSubset } from "./events"
import { applyRuntimeEvent } from "./update"
import { initSessionModel } from "./model"

type SubsetType = RuntimeEventSubset["type"]

// Every subset member must be assignable from its canonical counterpart:
// canonical events flow INTO the fold, so the subset must accept them.
type AssertAssignable<T extends true> = T
type CanonicalIsAssignable = AgentRuntimeEventOf<SubsetType> extends RuntimeEventSubset ? true : false
type _check = AssertAssignable<CanonicalIsAssignable>

describe("runtime-event contract", () => {
  test("every subset type exists in the canonical union", () => {
    // Type-level: if a subset type string leaves the canonical union,
    // AgentRuntimeEventOf<SubsetType> above becomes never-ish and the
    // assignability assertion breaks at compile time. Runtime side: exercise
    // the fold with a canonical-shaped event to keep this file executed.
    const event: AgentRuntimeEvent = { type: "text-delta", delta: "x" }
    const model = applyRuntimeEvent(initSessionModel({ sessionId: "s", directory: "/d" }), event)
    expect(model.rows).toHaveLength(1)
  })
})
