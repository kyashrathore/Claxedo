import type { EventEnvelope } from "../events";

/**
 * SyncEngine manages basic offline event buffering and pushes them
 * downstream when network connectivity is available.
 */
export class SyncEngine {
  private buffer: EventEnvelope[] = [];
  private lastCursor: number = 0;
  private batchSize: number = 50;
  private backoffMs: number = 0;
  private readonly baseBackoffMs: number = 1000;
  private readonly maxBackoffMs: number = 60000;

  /**
   * Pushes an event to the local buffer.
   */
  push(event: EventEnvelope) {
    this.buffer.push(event);
  }

  /**
   * Attempt to flush the buffer to a remote handler.
   * Flushes in batches of batchSize. On success, updates cursor and resets backoff.
   * On failure, applies exponential backoff.
   */
  async flush(remoteHandler: (events: EventEnvelope[]) => Promise<boolean>): Promise<boolean> {
    if (this.buffer.length === 0) {
      return true;
    }

    const batch = this.buffer.slice(0, this.batchSize);
    const success = await remoteHandler(batch);
    if (success) {
      this.lastCursor += batch.length;
      this.buffer = this.buffer.slice(batch.length);
      this.backoffMs = 0;
    } else {
      // Exponential backoff on failure
      if (this.backoffMs === 0) {
        this.backoffMs = this.baseBackoffMs;
      } else {
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      }
    }

    return success;
  }

  getPendingCount(): number {
    return this.buffer.length;
  }

  getCursor(): number {
    return this.lastCursor;
  }

  setBatchSize(size: number): void {
    this.batchSize = size;
  }

  getBackoffMs(): number {
    return this.backoffMs;
  }
}
