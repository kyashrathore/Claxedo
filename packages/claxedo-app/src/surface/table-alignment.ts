export type ColumnAlignment = "start" | "end"

type TableRow = Readonly<Record<string, unknown>>

export function columnAlignment(rows: readonly TableRow[], key: string): ColumnAlignment {
  const present = rows.map((row) => row[key]).filter((value) => value !== undefined && value !== null && value !== "")
  return present.length > 0 && present.every((value) => typeof value === "number") ? "end" : "start"
}
