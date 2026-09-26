type MarkdownTableCell = Pick<HTMLTableCellElement, "innerText" | "textContent">
type MarkdownTable = {
  readonly rows: ArrayLike<{ readonly cells: ArrayLike<MarkdownTableCell> }>
}

function cellText(cell: MarkdownTableCell) {
  return (cell.innerText || cell.textContent || "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\t/g, " ")
    .trim()
}

export function markdownTableText(table: MarkdownTable) {
  return Array.from(table.rows)
    .map((row) => Array.from(row.cells, cellText).join("\t"))
    .join("\n")
}
