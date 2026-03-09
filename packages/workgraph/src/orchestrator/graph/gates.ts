export class GateTracker {
  // Tracks which gates are satisfied
  private satisfiedGates: Set<string> = new Set();

  private key(sourceId: string, targetId: string): string {
    return `${sourceId}:${targetId}`;
  }

  // Gate key: `${sourceId}:${targetId}`
  satisfy(sourceId: string, targetId: string): void {
    this.satisfiedGates.add(this.key(sourceId, targetId));
  }

  reopen(sourceId: string, targetId: string): void {
    this.satisfiedGates.delete(this.key(sourceId, targetId));
  }

  isSatisfied(sourceId: string, targetId: string): boolean {
    return this.satisfiedGates.has(this.key(sourceId, targetId));
  }

  getSatisfiedCount(): number {
    return this.satisfiedGates.size;
  }

  clear(): void {
    this.satisfiedGates.clear();
  }
}
