import type { EventEnvelope } from "../../events";

export interface RepairResult {
  action: string;
  success: boolean;
  details: string;
  eventsProcessed?: number;
}

export async function verify(
  events: EventEnvelope[],
  hashVerifier: (events: EventEnvelope[]) => Promise<{ valid: boolean; brokenAt?: number }>
): Promise<RepairResult> {
  const result = await hashVerifier(events);
  return {
    action: "verify",
    success: result.valid,
    details: result.valid ? "Chain integrity verified" : `Chain broken at index ${result.brokenAt}`,
    eventsProcessed: events.length,
  };
}

export async function rebuild(
  events: EventEnvelope[],
  reducer: (state: any, event: EventEnvelope) => any,
  initialState: any
): Promise<{ result: RepairResult; state: any }> {
  let state = initialState;
  let count = 0;
  for (const event of events) {
    state = reducer(state, event);
    count++;
  }
  return {
    result: { action: "rebuild", success: true, details: `Rebuilt state from ${count} events`, eventsProcessed: count },
    state,
  };
}

export async function replay(
  events: EventEnvelope[],
  reducer: (state: any, event: EventEnvelope) => any,
  initialState: any,
  targetState: any
): Promise<RepairResult> {
  const { state } = await rebuild(events, reducer, initialState);
  const matches = JSON.stringify(state) === JSON.stringify(targetState);
  return {
    action: "replay",
    success: matches,
    details: matches ? "Replay matches target state" : "Replay diverged from target state",
    eventsProcessed: events.length,
  };
}

export async function reconcile(
  localEvents: EventEnvelope[],
  remoteEvents: EventEnvelope[]
): Promise<RepairResult> {
  // Find events in remote not in local (by op_id)
  const localOpIds = new Set(localEvents.map(e => e.op_id));
  const missing = remoteEvents.filter(e => !localOpIds.has(e.op_id));
  return {
    action: "reconcile",
    success: true,
    details: `Found ${missing.length} missing events to apply`,
    eventsProcessed: missing.length,
  };
}
