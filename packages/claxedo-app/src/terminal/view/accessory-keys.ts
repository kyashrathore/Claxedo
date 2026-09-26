export type AccessoryKey = "esc" | "tab" | "ctrl" | "up" | "down" | "left" | "right"

export type AccessoryKeyAction = { kind: "send"; data: string } | { kind: "arm"; ctrlArmed: boolean }

const BASE: Record<Exclude<AccessoryKey, "ctrl">, string> = {
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
}

const CTRL_ARROW: Partial<Record<AccessoryKey, string>> = {
  up: "\x1b[1;5A",
  down: "\x1b[1;5B",
  right: "\x1b[1;5C",
  left: "\x1b[1;5D",
}

export function resolveAccessoryKey(key: AccessoryKey, ctrlArmed: boolean): AccessoryKeyAction {
  if (key === "ctrl") return { kind: "arm", ctrlArmed: !ctrlArmed }
  const modified = ctrlArmed ? CTRL_ARROW[key] : undefined
  return { kind: "send", data: modified ?? BASE[key] }
}
