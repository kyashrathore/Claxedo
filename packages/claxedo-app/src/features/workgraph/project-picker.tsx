import { Select } from "@opencode-ai/ui/select"
import { createMemo, createSignal } from "solid-js"

export type LocalProjectOption = {
  value: string
  label: string
}

// A sentinel option that opens the shared folder picker instead of selecting a
// known project. It never becomes the picker's committed value.
const CHOOSE_ANOTHER = "__workgraph_choose_another_folder__"

type PickerOption = {
  value: string
  /** Basename shown on the trigger and in the list. */
  label: string
  /** Full path, surfaced as the option's tooltip. */
  title?: string
  action?: boolean
}

function basename(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

/** Selects a known local project as a compact chip, with the app shell supplying
 * the same folder picker used by New Project when the repository is not in the
 * recent list. Renders the shared `Select` so it matches the session composer's
 * workspace row. */
export function ProjectPicker(props: {
  value: string
  projects: readonly LocalProjectOption[]
  onChange: (value: string) => void
  onChoose?: () => Promise<string | undefined>
  onError?: (error: unknown) => void
}) {
  const [choosing, setChoosing] = createSignal(false)
  const knownOptions = createMemo<PickerOption[]>(() => {
    const current = props.value.trim()
    const projects = props.projects.map((project) => ({ value: project.value, label: basename(project.value), title: project.value }))
    if (!current || projects.some((project) => project.value === current)) return projects
    // Preserve a seeded/selected directory that isn't in the recent list so the
    // chip can still display it (e.g. "New stream in <project>").
    return [{ value: current, label: basename(current), title: current }, ...projects]
  })
  const options = createMemo<PickerOption[]>(() => [
    ...knownOptions(),
    { value: CHOOSE_ANOTHER, label: choosing() ? "Choosing…" : "Choose another folder…", action: true },
  ])
  const current = createMemo<PickerOption | undefined>(() => {
    const value = props.value.trim()
    if (!value) return undefined
    return knownOptions().find((option) => option.value === value) ?? { value, label: basename(value), title: value }
  })
  const choose = async () => {
    if (!props.onChoose || choosing()) return
    setChoosing(true)
    try {
      const directory = await props.onChoose()
      if (directory) props.onChange(directory)
    } catch (error) {
      props.onError?.(error)
    } finally {
      setChoosing(false)
    }
  }
  return (
    <Select<PickerOption>
      size="normal"
      variant="ghost"
      options={options()}
      current={current()}
      value={(option) => option.value}
      label={(option) => option.label}
      placeholder="Select a project"
      disabled={!props.projects.length && !props.onChoose}
      onSelect={(option) => {
        if (!option) return
        if (option.value === CHOOSE_ANOTHER) return void choose()
        props.onChange(option.value)
      }}
      class="workgraph-chip-select max-w-[200px] justify-start text-text-base"
      valueClass="truncate text-13-regular text-text-weak"
      triggerProps={{ "aria-label": "Project directory" }}
    >
      {(option) => <span title={option?.title}>{option?.label}</span>}
    </Select>
  )
}
