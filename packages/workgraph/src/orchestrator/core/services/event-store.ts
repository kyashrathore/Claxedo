import type { EventEnvelope } from "../../events";
import { events } from "../db/schema";
import { eq, and, gt } from "drizzle-orm";

export async function appendEvent(db: any, envelope: EventEnvelope): Promise<void> {
  try {
    await db.insert(events).values(envelope);
  } catch (err: any) {
    if (err?.message?.includes("UNIQUE constraint")) return;
    throw err;
  }
}

export async function getEvents(db: any, runId: string, sinceSeq?: number): Promise<EventEnvelope[]> {
  if (sinceSeq !== undefined) {
    return db.select().from(events).where(and(eq(events.run_id, runId), gt(events.stream_seq, sinceSeq)));
  }
  return db.select().from(events).where(eq(events.run_id, runId));
}

export async function replayEvents<S>(db: any, runId: string, reducer: (state: S, event: EventEnvelope) => S, initialState: S): Promise<S> {
  const evts = await getEvents(db, runId);
  return evts.reduce((state, event) => reducer(state, event), initialState);
}
