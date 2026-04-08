export type ConflictStrategy = "lww" | "or_set" | "append_merge";

export interface Conflict {
  id: string;
  eventId: string;
  localValue: any;
  remoteValue: any;
  detectedAt: string;
  resolvedAt?: string;
  strategy?: ConflictStrategy;
  resolution?: any;
}

export function detectConflict(localEvent: any, remoteEvent: any): Conflict | null {
  // Same run_id + same stream_id + same stream_seq = conflict
  if (localEvent.run_id === remoteEvent.run_id &&
      localEvent.stream_id === remoteEvent.stream_id &&
      localEvent.stream_seq === remoteEvent.stream_seq &&
      localEvent.id !== remoteEvent.id) {
    return {
      id: `conflict_${Date.now()}`,
      eventId: localEvent.id,
      localValue: localEvent,
      remoteValue: remoteEvent,
      detectedAt: new Date().toISOString(),
    };
  }
  return null;
}

export function resolveConflict(conflict: Conflict, strategy: ConflictStrategy): Conflict {
  let resolution: any;
  switch (strategy) {
    case "lww": // Last-writer-wins based on created_at
      resolution = conflict.localValue.created_at > conflict.remoteValue.created_at
        ? conflict.localValue : conflict.remoteValue;
      break;
    case "or_set": // Union of both values
      resolution = { merged: [conflict.localValue, conflict.remoteValue] };
      break;
    case "append_merge": // Append both, let consumer sort
      resolution = { local: conflict.localValue, remote: conflict.remoteValue, merged: true };
      break;
  }
  return { ...conflict, strategy, resolution, resolvedAt: new Date().toISOString() };
}

export function reconcile(conflicts: Conflict[], strategy: ConflictStrategy): Conflict[] {
  return conflicts.map(c => c.resolvedAt ? c : resolveConflict(c, strategy));
}
