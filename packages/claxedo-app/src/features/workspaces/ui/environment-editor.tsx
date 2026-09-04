import { Index, Show } from "solid-js"

/**
 * Key/value rows for a project's environment — what every cloud sandbox of
 * the project starts with. Values are shown as entered: they are readable
 * inside the sandbox by design; credentials the agent must not read belong in
 * Connections.
 */
export type EnvironmentRow = { id: number; name: string; value: string }

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function environmentRows(env: Record<string, string> | undefined): EnvironmentRow[] {
  const rows = Object.entries(env ?? {}).map(([name, value], index) => ({ id: index + 1, name, value }))
  return rows.length ? rows : [{ id: 1, name: "", value: "" }]
}

/** Rows with a name become variables; a row with neither name nor value is an empty line and is dropped. */
export function environmentRecord(rows: readonly EnvironmentRow[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) continue
    record[name] = row.value
  }
  return record
}

/** Why the rows cannot be saved yet, or `undefined` when they can. */
export function environmentRowsProblem(rows: readonly EnvironmentRow[]): string | undefined {
  const seen = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) {
      if (row.value.trim()) return "Each value needs a variable name"
      continue
    }
    if (!ENVIRONMENT_NAME.test(name)) return `"${name}" is not a valid variable name`
    if (seen.has(name)) return `"${name}" is listed twice`
    seen.add(name)
  }
  return undefined
}

export function EnvironmentEditor(props: { rows: EnvironmentRow[]; onChange: (rows: EnvironmentRow[]) => void }) {
  let nextId = Math.max(0, ...props.rows.map((row) => row.id)) + 1
  const update = (id: number, patch: Partial<EnvironmentRow>) =>
    props.onChange(props.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const add = () => props.onChange([...props.rows, { id: nextId++, name: "", value: "" }])
  const remove = (id: number) =>
    props.onChange(
      props.rows.length > 1 ? props.rows.filter((row) => row.id !== id) : [{ id: nextId++, name: "", value: "" }],
    )
  const problem = () => environmentRowsProblem(props.rows)
  const field =
    "px-2.5 py-1.5 font-mono text-13-regular bg-surface-inset-base border border-border-base rounded-md text-text-strong focus:outline-none focus:border-border-interactive-base"

  return (
    <div class="flex flex-col gap-2" role="group" aria-label="Environment variables">
      <Index each={props.rows}>
        {(row) => (
          <div class="flex items-center gap-2">
            <input
              type="text"
              value={row().name}
              onInput={(event) => update(row().id, { name: event.currentTarget.value })}
              placeholder="NAME"
              aria-label="Variable name"
              spellcheck={false}
              class={`w-2/5 ${field}`}
            />
            <input
              type="text"
              value={row().value}
              onInput={(event) => update(row().id, { value: event.currentTarget.value })}
              placeholder="value"
              aria-label="Variable value"
              spellcheck={false}
              class={`flex-1 ${field}`}
            />
            <button
              type="button"
              aria-label="Remove variable"
              class="px-2 text-text-weak hover:text-text-strong"
              onClick={() => remove(row().id)}
            >
              ×
            </button>
          </div>
        )}
      </Index>
      <div class="flex items-center gap-3">
        <button type="button" class="text-12-medium text-text-interactive-base" onClick={add}>
          + Add variable
        </button>
        <Show when={problem()}>{(text) => <span class="text-11-regular text-icon-warning-base">{text()}</span>}</Show>
      </div>
    </div>
  )
}
