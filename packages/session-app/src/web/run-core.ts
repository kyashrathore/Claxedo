/**
 * The Elm↔Solid 2 bridge (U11b in the plan).
 *
 * The authoritative model lives OUTSIDE the store, in `current`: `update` is
 * pure and synchronous, so reads never depend on Solid 2's staged-write
 * semantics (writes commit on the next microtask — reading the store right
 * after a set returns the last committed value, which is exactly why the
 * source of truth cannot live there).
 *
 * The store is a projection. After each update, `applyModelDiff` writes ONLY
 * what changed into the setter's draft — scalars by comparison, rows by
 * identity, which `update` preserves for untouched rows (pinned by a core
 * test). A token burst therefore commits as one microtask flush touching one
 * row, which is the streaming granularity the perf gates require.
 */

import { createStore } from "solid-js"
import type { SessionEffect, SessionModel, SessionMsg } from "../core/model"
import { update } from "../core/update"

export type CoreHandle = {
  model: SessionModel
  dispatch: (msg: SessionMsg) => void
}

export function runCore(
  initial: SessionModel,
  runEffect: (effect: SessionEffect, dispatch: (msg: SessionMsg) => void) => void,
): CoreHandle {
  let current = initial
  const [model, setModel] = createStore<SessionModel>(structuredClone(initial))

  const dispatch = (msg: SessionMsg) => {
    const previous = current
    const result = update(current, msg)
    current = result.model
    if (current !== previous) {
      setModel((draft: SessionModel) => applyModelDiff(draft, previous, current))
    }
    for (const effect of result.effects) runEffect(effect, dispatch)
  }

  return { model, dispatch }
}

const SCALAR_KEYS = ["sessionId", "directory", "title", "status", "connection", "draft", "sending", "lastError"] as const

function applyModelDiff(draft: SessionModel, previous: SessionModel, next: SessionModel) {
  for (const key of SCALAR_KEYS) {
    if (previous[key] !== next[key]) {
      // Draft mutation is the Solid 2 store update form; each write here marks
      // exactly one leaf dirty.
      ;(draft as Record<string, unknown>)[key] = next[key]
    }
  }
  const rows = next.rows
  const prevRows = previous.rows
  for (let i = 0; i < rows.length; i++) {
    if (prevRows[i] !== rows[i]) draft.rows[i] = rows[i]
  }
  if (draft.rows.length > rows.length) draft.rows.length = rows.length
}
