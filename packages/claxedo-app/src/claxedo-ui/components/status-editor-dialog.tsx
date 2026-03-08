/**
 * StatusEditorDialog — Manage page status definitions.
 *
 * Create, edit, delete statuses and define allowed transitions.
 * Uses <Dialog> from @opencode-ai/ui/dialog (Kobalte).
 */

import { createSignal, For, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { pagesApi, type PageStatus } from "../../utils/pages-api"

const PRESET_COLORS = [
  "#6b7280",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#9ca3af",
]

type StatusEditorDialogProps = {
  statuses: PageStatus[]
  onSave: (statuses: PageStatus[]) => void
}

export function StatusEditorDialog(props: StatusEditorDialogProps) {
  const [items, setItems] = createSignal<PageStatus[]>(
    props.statuses.map((s) => ({ ...s })),
  )
  const [saving, setSaving] = createSignal(false)

  const updateItem = (index: number, patch: Partial<PageStatus>) => {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    )
  }

  const addStatus = () => {
    const id = `status_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    setItems((prev) => [
      ...prev,
      {
        id,
        name: "New Status",
        color: PRESET_COLORS[prev.length % PRESET_COLORS.length],
        position: prev.length,
        transitions: [],
      },
    ])
  }

  const removeStatus = (index: number) => {
    setItems((prev) => {
      const next = prev.filter((_, i) => i !== index)
      return next.map((item, i) => ({ ...item, position: i }))
    })
  }

  const moveUp = (index: number) => {
    if (index === 0) return
    setItems((prev) => {
      const next = [...prev]
      ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
      return next.map((item, i) => ({ ...item, position: i }))
    })
  }

  const moveDown = (index: number) => {
    setItems((prev) => {
      if (index >= prev.length - 1) return prev
      const next = [...prev]
      ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
      return next.map((item, i) => ({ ...item, position: i }))
    })
  }

  const toggleTransition = (index: number, targetId: string) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item
        const has = item.transitions.includes(targetId)
        return {
          ...item,
          transitions: has
            ? item.transitions.filter((t) => t !== targetId)
            : [...item.transitions, targetId],
        }
      }),
    )
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const saved = await pagesApi.saveStatuses(items())
      props.onSave(saved)
      showToast({ title: "Statuses saved", variant: "success" })
    } catch (err) {
      showToast({
        title: "Failed to save statuses",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog>
      <div class="flex flex-col gap-4 p-4 max-h-[80vh] overflow-auto min-w-[420px]">
        <div class="text-14-medium text-text-strong">Configure Statuses</div>

        <div class="flex flex-col gap-3">
          <For each={items()}>
            {(item, index) => (
              <div class="flex flex-col gap-2 p-3 rounded-md border border-border-weak-base bg-surface-base">
                {/* Name + controls */}
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    class="flex-1 min-w-0 px-2 py-1 text-12-regular rounded border border-border-weak-base bg-background-base text-text-base focus:outline-none focus:ring-1 focus:ring-accent-base"
                    value={item.name}
                    onInput={(e) => updateItem(index(), { name: e.currentTarget.value })}
                  />
                  <div class="flex items-center">
                    <button
                      type="button"
                      class="flex items-center justify-center w-6 h-6 rounded transition-colors text-text-weaker hover:text-text-base hover:bg-surface-base-hover disabled:opacity-30 disabled:pointer-events-none"
                      onClick={() => moveUp(index())}
                      disabled={index() === 0}
                      aria-label="Move up"
                    >
                      <div style="transform: rotate(180deg);">
                        <Icon name="chevron-down" size="small" />
                      </div>
                    </button>
                    <button
                      type="button"
                      class="flex items-center justify-center w-6 h-6 rounded transition-colors text-text-weaker hover:text-text-base hover:bg-surface-base-hover disabled:opacity-30 disabled:pointer-events-none"
                      onClick={() => moveDown(index())}
                      disabled={index() === items().length - 1}
                      aria-label="Move down"
                    >
                      <Icon name="chevron-down" size="small" />
                    </button>
                  </div>
                  <button
                    type="button"
                    class="flex items-center justify-center w-6 h-6 rounded transition-colors text-text-weaker hover:text-red-500 hover:bg-surface-base-hover"
                    onClick={() => removeStatus(index())}
                    aria-label="Delete status"
                  >
                    <Icon name="close-small" size="small" />
                  </button>
                </div>

                {/* Color swatches */}
                <div class="flex items-center gap-1">
                  <span class="text-[10px] text-text-weaker mr-1">Color</span>
                  <For each={PRESET_COLORS}>
                    {(color) => (
                      <button
                        type="button"
                        class="w-4 h-4 rounded-full border-2 transition-colors"
                        classList={{
                          "border-text-strong": item.color === color,
                          "border-transparent hover:border-text-weak": item.color !== color,
                        }}
                        style={{ "background-color": color }}
                        onClick={() => updateItem(index(), { color })}
                        aria-label={`Color ${color}`}
                      />
                    )}
                  </For>
                </div>

                {/* Transitions checkboxes */}
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-[10px] text-text-weaker">Transitions to:</span>
                  <For each={items().filter((s) => s.id !== item.id)}>
                    {(other) => (
                      <label class="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          class="accent-accent-base"
                          checked={item.transitions.includes(other.id)}
                          onChange={() => toggleTransition(index(), other.id)}
                        />
                        <span
                          class="text-[10px]"
                          style={{ color: other.color }}
                        >
                          {other.name}
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>

        <button
          type="button"
          class="flex items-center gap-1 text-12-regular text-text-weak hover:text-text-base transition-colors"
          onClick={addStatus}
        >
          + Add Status
        </button>

        {/* Footer */}
        <div class="flex justify-end gap-2 pt-2 border-t border-border-weak-base">
          <button
            type="button"
            class="px-3 py-1.5 text-12-medium rounded-md border border-border-weak-base text-text-base hover:bg-surface-base-hover transition-colors"
            onClick={() => {
              // Reset to original
              setItems(props.statuses.map((s) => ({ ...s })))
            }}
          >
            Reset
          </button>
          <button
            type="button"
            class="px-3 py-1.5 text-12-medium rounded-md bg-accent-base text-white hover:bg-accent-base/90 transition-colors disabled:opacity-50"
            disabled={saving()}
            onClick={handleSave}
          >
            {saving() ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
