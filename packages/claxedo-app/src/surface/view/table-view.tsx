import { createMemo, For, Index } from "solid-js"
import { boundText } from "../binding"
import type { SurfaceNodeProps } from "../model"
import { columnAlignment, type ColumnAlignment } from "../table-alignment"
import { useSurfaceReader } from "./surface-runtime"

type TableRow = Readonly<Record<string, unknown>>

const NO_ROWS: readonly TableRow[] = []

function tableRows(value: unknown): readonly TableRow[] {
  return Array.isArray(value) ? value.filter((row): row is TableRow => typeof row === "object" && row !== null && !Array.isArray(row)) : NO_ROWS
}

export function TableView(props: SurfaceNodeProps<"Table">) {
  const read = useSurfaceReader()
  const rows = createMemo(() => tableRows(read.value(props.def.rows, props.scope)))
  const alignments = createMemo(() => new Map<string, ColumnAlignment>(props.def.columns.map((column) => [column.key, columnAlignment(rows(), column.key)])))
  const align = (key: string) => alignments().get(key) ?? "start"
  return (
    <div data-slot="surface-table-scroll">
      <table data-slot="surface-table">
        <thead>
          <tr>
            <For each={props.def.columns}>
              {(column) => (
                <th scope="col" data-align={align(column.key)}>
                  {read.text(column.title, props.scope)}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <Index each={rows()}>
            {(row) => (
              <tr>
                <For each={props.def.columns}>
                  {(column) => (
                    <td data-align={align(column.key)} data-label={read.text(column.title, props.scope)}>
                      {boundText(row()[column.key])}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </Index>
        </tbody>
      </table>
    </div>
  )
}
