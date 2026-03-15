import type { EventEnvelope } from "../../events";

export async function computeHash(event: EventEnvelope, prevHash: string): Promise<string> {
  const input = `${prevHash}${event.type}${event.payload_json}${event.run_id}${event.stream_seq}`;
  const hash = new Bun.CryptoHasher("sha256").update(input).digest("hex");
  return hash;
}

export async function verifyChain(events: EventEnvelope[]): Promise<{ valid: boolean; brokenAt?: number }> {
  for (let i = 0; i < events.length; i++) {
    const prevHash = i === 0 ? "00000000" : events[i - 1].hash;
    const computed = await computeHash(events[i], prevHash);
    if (computed !== events[i].hash) {
      return { valid: false, brokenAt: i };
    }
  }
  return { valid: true };
}
