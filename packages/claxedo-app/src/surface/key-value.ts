export type KeyValueSource = { readonly label: unknown; readonly value: unknown }

const NO_ROWS: readonly KeyValueSource[] = []

function isKeyValueSource(item: unknown): item is KeyValueSource {
  return typeof item === "object" && item !== null && !Array.isArray(item) && "label" in item
}

export function keyValueRows(items: unknown): readonly KeyValueSource[] {
  return Array.isArray(items) ? items.filter(isKeyValueSource) : NO_ROWS
}
