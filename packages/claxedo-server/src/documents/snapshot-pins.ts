import { DocumentInvalidEntryError } from "./errors"

export const MAX_SNAPSHOT_PINS = 128
export const MAX_SNAPSHOT_METADATA_BYTES = 64 * 1024
const MAX_PIN_BYTES = 512

export function boundedSnapshotPins(input: readonly string[], now: number) {
  const permanent = new Set<string>()
  const leases = new Map<string, { pin: string; expiresAt: number }>()
  for (const pin of input) {
    if (!pin.trim() || new TextEncoder().encode(pin).byteLength > MAX_PIN_BYTES) {
      throw new DocumentInvalidEntryError("Snapshot pin is invalid or too large")
    }
    const lease = parseLease(pin)
    if (!lease) {
      permanent.add(pin)
      continue
    }
    if (lease.expiresAt <= now) continue
    const current = leases.get(lease.purpose)
    if (!current || current.expiresAt < lease.expiresAt) leases.set(lease.purpose, { pin, expiresAt: lease.expiresAt })
  }
  const pins = [...permanent, ...[...leases.values()].map((lease) => lease.pin)].sort()
  if (pins.length > MAX_SNAPSHOT_PINS) throw new DocumentInvalidEntryError("Snapshot pin limit exceeded")
  return pins
}

export function requireBoundedSnapshotMetadata(value: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(value))
  if (encoded.byteLength > MAX_SNAPSHOT_METADATA_BYTES) {
    throw new DocumentInvalidEntryError("Snapshot metadata limit exceeded")
  }
  return encoded
}

export function expiredSnapshotLease(pin: string, now: number) {
  if (!pin.startsWith("lease:")) return false
  const expiresAt = Number(pin.split(":", 3)[1])
  return Number.isFinite(expiresAt) && expiresAt <= now
}

function parseLease(pin: string) {
  if (!pin.startsWith("lease:")) return
  const [, rawExpiresAt, purpose] = pin.split(":", 3)
  const expiresAt = Number(rawExpiresAt)
  if (!Number.isFinite(expiresAt) || !purpose) throw new DocumentInvalidEntryError("Snapshot lease pin is invalid")
  return { expiresAt, purpose }
}
