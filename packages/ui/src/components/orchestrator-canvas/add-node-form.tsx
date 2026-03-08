// ---------------------------------------------------------------------------
// Form overlay for injecting new nodes mid-execution
// ---------------------------------------------------------------------------

import { createSignal, For } from "solid-js"
import type { OrchestratorNode } from "./types"

interface AddNodeFormProps {
  existingNodes: OrchestratorNode[]
  onSubmit: (node: {
    title: string
    kind: string
    prompt: string
    depends_on: string[]
  }) => void
  onCancel: () => void
}

export function AddNodeForm(props: AddNodeFormProps) {
  const [title, setTitle] = createSignal("")
  const [kind, setKind] = createSignal("code_gen")
  const [prompt, setPrompt] = createSignal("")
  const [deps, setDeps] = createSignal<string[]>([])

  const kinds = ["research", "code_gen", "review", "test", "docs", "design"]

  const toggleDep = (id: string) => {
    setDeps((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    )
  }

  const handleSubmit = (e: Event) => {
    e.preventDefault()
    if (!title().trim() || !prompt().trim()) return
    props.onSubmit({
      title: title().trim(),
      kind: kind(),
      prompt: prompt().trim(),
      depends_on: deps(),
    })
  }

  return (
    <div data-component="oc-add-node-form">
      <div data-slot="oc-form-header">
        <span>Add Task Node</span>
        <button data-slot="oc-form-close" onClick={props.onCancel}>
          {"\u2715"}
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        <div data-slot="oc-form-field">
          <label>Title</label>
          <input
            type="text"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            placeholder="Task title"
            data-slot="oc-form-input"
          />
        </div>

        <div data-slot="oc-form-field">
          <label>Kind</label>
          <select
            value={kind()}
            onChange={(e) => setKind(e.currentTarget.value)}
            data-slot="oc-form-select"
          >
            <For each={kinds}>{(k) => <option value={k}>{k}</option>}</For>
          </select>
        </div>

        <div data-slot="oc-form-field">
          <label>Prompt</label>
          <textarea
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            placeholder="Detailed instructions for the agent..."
            rows={4}
            data-slot="oc-form-textarea"
          />
        </div>

        <div data-slot="oc-form-field">
          <label>Depends on</label>
          <div data-slot="oc-form-deps">
            <For each={props.existingNodes}>
              {(node) => (
                <label data-slot="oc-form-dep-item">
                  <input
                    type="checkbox"
                    checked={deps().includes(node.id)}
                    onChange={() => toggleDep(node.id)}
                  />
                  <span>{node.title}</span>
                  <span data-slot="oc-form-dep-status" data-status={node.status}>
                    {node.status}
                  </span>
                </label>
              )}
            </For>
          </div>
        </div>

        <div data-slot="oc-form-actions">
          <button
            type="button"
            data-slot="oc-form-btn"
            data-variant="secondary"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-slot="oc-form-btn"
            data-variant="primary"
            disabled={!title().trim() || !prompt().trim()}
          >
            Add Node
          </button>
        </div>
      </form>
    </div>
  )
}
