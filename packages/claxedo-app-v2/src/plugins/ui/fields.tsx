import { For, Show, createUniqueId, type Component } from "solid-js"
import type { SelectProps, SwitchProps, TabsProps, TextInputProps, TextareaProps } from "@claxedo/plugin-api"

function FieldFrame(props: { readonly id: string; readonly label?: string; readonly error?: string; readonly children: unknown }) {
  return (
    <div class="flex flex-col gap-1">
      <Show when={props.label}>
        <label for={props.id} class="text-xs">
          {props.label}
        </label>
      </Show>
      {props.children as never}
      <Show when={props.error}>
        <p id={`${props.id}-error`} role="alert" class="text-xs">
          {props.error}
        </p>
      </Show>
    </div>
  )
}

export const TextInput: Component<TextInputProps> = (props) => {
  const id = createUniqueId()
  return (
    <FieldFrame id={id} label={props.label} error={props.error}>
      <input
        id={id}
        type="text"
        class={`rounded-md border px-2 py-1 text-sm ${props.class ?? ""}`}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autofocus={props.autofocus}
        aria-label={props["aria-label"]}
        aria-invalid={props.error ? "true" : undefined}
        aria-describedby={props.error ? `${id}-error` : undefined}
        data-testid={props["data-testid"]}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => props.onKeyDown?.(event)}
      />
    </FieldFrame>
  )
}

export const Textarea: Component<TextareaProps> = (props) => {
  const id = createUniqueId()
  return (
    <FieldFrame id={id} label={props.label} error={props.error}>
      <textarea
        id={id}
        rows={props.rows ?? 4}
        class={`rounded-md border px-2 py-1 text-sm ${props.class ?? ""}`}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autofocus={props.autofocus}
        aria-label={props["aria-label"]}
        aria-invalid={props.error ? "true" : undefined}
        data-testid={props["data-testid"]}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => props.onKeyDown?.(event)}
      />
    </FieldFrame>
  )
}

export const Select: Component<SelectProps> = (props) => {
  const id = createUniqueId()
  return (
    <FieldFrame id={id} label={props.label}>
      <select
        id={id}
        class={`rounded-md border px-2 py-1 text-sm ${props.class ?? ""}`}
        value={props.value ?? ""}
        disabled={props.disabled}
        aria-label={props["aria-label"]}
        data-testid={props["data-testid"]}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <Show when={props.placeholder}>
          <option value="" disabled>
            {props.placeholder}
          </option>
        </Show>
        <For each={props.options}>
          {(option) => (
            <option value={option.value} disabled={option.disabled} selected={option.value === props.value}>
              {option.label}
            </option>
          )}
        </For>
      </select>
    </FieldFrame>
  )
}

export const Switch: Component<SwitchProps> = (props) => (
  <button
    type="button"
    role="switch"
    aria-checked={props.checked}
    aria-label={props.label}
    disabled={props.disabled}
    data-testid={props["data-testid"]}
    class="inline-flex h-5 w-9 items-center rounded-full border p-0.5"
    onClick={() => props.onChange(!props.checked)}
  >
    <span class="size-4 rounded-full border" classList={{ "translate-x-4": props.checked }} />
  </button>
)

export const Tabs: Component<TabsProps> = (props) => (
  <div role="tablist" aria-label={props["aria-label"]} class="flex gap-1">
    <For each={props.tabs}>
      {(tab) => (
        <button
          type="button"
          role="tab"
          aria-selected={tab.value === props.value}
          class="rounded-md px-2 py-1 text-sm"
          onClick={() => props.onChange(tab.value)}
        >
          {tab.label}
        </button>
      )}
    </For>
  </div>
)
