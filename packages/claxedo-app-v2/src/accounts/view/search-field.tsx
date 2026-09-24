import { TextField } from "@opencode-ai/ui/text-field"
import { Show } from "solid-js"
import { ClaxedoIcon as Icon, ClaxedoIconButton as IconButton } from "@/ui"

export function SearchField(props: { readonly value: string; readonly onChange: (value: string) => void; readonly placeholder: string; readonly action: string }) {
  return (
    <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
      <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
      <TextField
        variant="ghost"
        type="text"
        value={props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
        spellcheck={false}
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
        class="flex-1"
        data-action={props.action}
      />
      <Show when={props.value}>
        <IconButton icon="circle-x" variant="ghost" onClick={() => props.onChange("")} />
      </Show>
    </div>
  )
}
