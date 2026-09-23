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

/**
 * Clipboard text for a rendered Markdown table. Tabs and newlines preserve the
 * table shape when pasted into spreadsheet apps while remaining useful in a
 * plain-text editor.
 */
export function markdownTableText(table: MarkdownTable) {
  return Array.from(table.rows)
    .map((row) => Array.from(row.cells, cellText).join("\t"))
    .join("\n")
}
