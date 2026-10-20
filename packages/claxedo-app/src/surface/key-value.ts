export type KeyValueRow =
  | { readonly label: unknown; readonly kind: "text"; readonly value: unknown }
  | { readonly label: unknown; readonly kind: "child"; readonly child: string }

const NO_ROWS: readonly KeyValueRow[] = []

function isLabelled(item: unknown): item is { readonly label: unknown; readonly value?: unknown; readonly child?: unknown } {
  return typeof item === "object" && item !== null && !Array.isArray(item) && "label" in item
}

export function keyValueRows(items: unknown, literal: boolean): readonly KeyValueRow[] {
  if (!Array.isArray(items)) return NO_ROWS
  return items.filter(isLabelled).map((item) =>
    literal && typeof item.child === "string" ? { label: item.label, kind: "child", child: item.child } : { label: item.label, kind: "text", value: item.value },
  )
}
