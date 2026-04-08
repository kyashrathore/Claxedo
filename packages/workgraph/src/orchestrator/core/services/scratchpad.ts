export interface ScratchpadEntry {
  id: string;
  runId: string;
  nodeId: string;
  content: string;
  createdAt: string;
  expiresAt: string;
  sizeBytes: number;
}

export interface ScratchpadConfig {
  ttlMs: number; // default 24 * 60 * 60 * 1000 (24h)
  maxSizeBytes: number; // default 10 * 1024 * 1024 (10MB)
}

export class ScratchpadService {
  private entries: Map<string, ScratchpadEntry> = new Map();
  private config: ScratchpadConfig;
  private totalSize: number = 0;

  constructor(config?: Partial<ScratchpadConfig>) {
    this.config = {
      ttlMs: config?.ttlMs ?? 24 * 60 * 60 * 1000,
      maxSizeBytes: config?.maxSizeBytes ?? 10 * 1024 * 1024,
    };
  }

  write(
    runId: string,
    nodeId: string,
    id: string,
    content: string
  ): ScratchpadEntry {
    this.cleanup(); // Remove expired entries first
    const sizeBytes = new TextEncoder().encode(content).length;
    if (this.totalSize + sizeBytes > this.config.maxSizeBytes) {
      throw new Error("Scratchpad size limit exceeded");
    }
    const now = new Date();
    const entry: ScratchpadEntry = {
      id,
      runId,
      nodeId,
      content,
      sizeBytes,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.ttlMs).toISOString(),
    };
    this.entries.set(id, entry);
    this.totalSize += sizeBytes;
    return entry;
  }

  read(runId: string): ScratchpadEntry[] {
    this.cleanup();
    return Array.from(this.entries.values()).filter((e) => e.runId === runId);
  }

  get(id: string): ScratchpadEntry | undefined {
    this.cleanup();
    return this.entries.get(id);
  }

  promote(
    id: string
  ): {
    entry: ScratchpadEntry;
    artifact: { id: string; content: string; nodeId: string };
  } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.entries.delete(id);
    this.totalSize -= entry.sizeBytes;
    return {
      entry,
      artifact: {
        id: `artifact_${id}`,
        content: entry.content,
        nodeId: entry.nodeId,
      },
    };
  }

  cleanup(): void {
    const now = new Date().toISOString();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.totalSize -= entry.sizeBytes;
        this.entries.delete(id);
      }
    }
  }

  getTotalSize(): number {
    return this.totalSize;
  }

  getEntryCount(): number {
    return this.entries.size;
  }
}
