import { Button } from "@opencode-ai/ui/button"
import { createMemo, createSignal, For } from "solid-js"

export type LocalProjectOption = {
  value: string
  label: string
}

/** Selects a known local project, with the app shell supplying the same folder
 * picker used by New Project when the repository is not in the recent list. */
export function ProjectPicker(props: {
  value: string
  projects: readonly LocalProjectOption[]
  onChange: (value: string) => void
  onChoose?: () => Promise<string | undefined>
  onError?: (error: unknown) => void
}) {
  const [choosing, setChoosing] = createSignal(false)
  const options = createMemo(() => {
    const current = props.value.trim()
    if (!current || props.projects.some((project) => project.value === current)) return props.projects
    return [{ value: current, label: current }, ...props.projects]
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
    <div class="workgraph-project-picker">
      <select
        class="workgraph-project-select"
        aria-label="Project directory"
        value={props.value}
        required
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <option value="">Select a project</option>
        <For each={options()}>{(project) => <option value={project.value}>{project.label}</option>}</For>
      </select>
      <Button type="button" size="small" variant="ghost" disabled={!props.onChoose || choosing()} onClick={() => void choose()}>
        {choosing() ? "Choosing…" : "Choose another folder…"}
      </Button>
    </div>
  )
}
