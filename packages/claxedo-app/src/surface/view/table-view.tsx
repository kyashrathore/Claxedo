import { For, Index } from "solid-js"
import { boundText } from "../binding"
import type { SurfaceNodeProps } from "../model"
import { useSurfaceReader } from "./surface-runtime"

type TableRow = Readonly<Record<string, unknown>>

const NO_ROWS: readonly TableRow[] = []

function tableRows(value: unknown): readonly TableRow[] {
  return Array.isArray(value) ? value.filter((row): row is TableRow => typeof row === "object" && row !== null && !Array.isArray(row)) : NO_ROWS
}

export function TableView(props: SurfaceNodeProps<"Table">) {
  const read = useSurfaceReader()
  const rows = () => tableRows(read.value(props.def.rows, props.scope))
  return (
    <div data-slot="surface-table-scroll">
      <table data-slot="surface-table">
        <thead>
          <tr>
            <For each={props.def.columns}>{(column) => <th scope="col">{read.text(column.title, props.scope)}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <Index each={rows()}>
            {(row) => (
              <tr>
                <For each={props.def.columns}>{(column) => <td>{boundText(row()[column.key])}</td>}</For>
              </tr>
            )}
          </Index>
        </tbody>
      </table>
    </div>
  )
}
