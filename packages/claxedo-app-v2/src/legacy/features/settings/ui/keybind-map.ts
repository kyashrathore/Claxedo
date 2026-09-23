import { asRecord } from "@/lib/record"

/** A command id to the keybind string configured for it. */
export type KeybindMap = Record<string, string | undefined>

/**
 * The keybind map as read off persisted settings.
 *
 * The value arrives from user-editable config, so nothing about its shape is
 * guaranteed. Every consumer hands an entry straight to `parseKeybind`, which
 * splits it — so a non-string value stored under a command id is dropped here
 * rather than reaching a caller that would throw on it.
 */
export function parseKeybindMap(value: unknown): KeybindMap {
  const stored = asRecord(value)
  if (!stored) return {}
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}
