import { Index, Show } from "solid-js"
import { useProjectsText, type ProjectsText } from "../i18n"

export type EnvironmentRow = { id: number; name: string; value: string }

export type EnvironmentProblem = { kind: "unnamed" } | { kind: "invalid"; name: string } | { kind: "duplicate"; name: string }

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function environmentRows(env: Record<string, string> | undefined): EnvironmentRow[] {
  const rows = Object.entries(env ?? {}).map(([name, value], index) => ({ id: index + 1, name, value }))
  return rows.length ? rows : [{ id: 1, name: "", value: "" }]
}

export function environmentRecord(rows: readonly EnvironmentRow[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) continue
    record[name] = row.value
  }
  return record
}

export function environmentRowsProblem(rows: readonly EnvironmentRow[]): EnvironmentProblem | undefined {
  const seen = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) {
      if (row.value.trim()) return { kind: "unnamed" }
      continue
    }
    if (!ENVIRONMENT_NAME.test(name)) return { kind: "invalid", name }
    if (seen.has(name)) return { kind: "duplicate", name }
    seen.add(name)
  }
  return undefined
}

export function environmentProblemText(t: ProjectsText, problem: EnvironmentProblem): string {
  if (problem.kind === "unnamed") return t("projects.environment.unnamed")
  if (problem.kind === "invalid") return t("projects.environment.invalid", { name: problem.name })
  return t("projects.environment.duplicate", { name: problem.name })
}

export function EnvironmentEditor(props: { rows: EnvironmentRow[]; onChange: (rows: EnvironmentRow[]) => void }) {
  const t = useProjectsText()
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
    <div class="flex flex-col gap-2" role="group" aria-label={t("projects.environment.label")}>
      <Index each={props.rows}>
        {(row) => (
          <div class="flex items-center gap-2">
            <input
              type="text"
              value={row().name}
              onInput={(event) => update(row().id, { name: event.currentTarget.value })}
              placeholder={t("projects.environment.name.placeholder")}
              aria-label={t("projects.environment.name")}
              spellcheck={false}
              class={`w-2/5 ${field}`}
            />
            <input
              type="text"
              value={row().value}
              onInput={(event) => update(row().id, { value: event.currentTarget.value })}
              placeholder={t("projects.environment.value.placeholder")}
              aria-label={t("projects.environment.value")}
              spellcheck={false}
              class={`flex-1 ${field}`}
            />
            <button
              type="button"
              aria-label={t("projects.environment.remove")}
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
          {t("projects.environment.add")}
        </button>
        <Show when={problem()}>{(found) => <span class="text-11-regular text-icon-warning-base">{environmentProblemText(t, found())}</span>}</Show>
      </div>
    </div>
  )
}
