import { ClaxedoIcon as Icon, LabelledTextField } from "@/ui"

export function SearchField(props: { readonly value: string; readonly onChange: (value: string) => void; readonly placeholder: string; readonly action: string }) {
  return (
    <LabelledTextField
      type="text"
      leadingIcon={<Icon name="magnifying-glass" />}
      value={props.value}
      onChange={props.onChange}
      placeholder={props.placeholder}
      spellcheck={false}
      autocorrect="off"
      autocomplete="off"
      autocapitalize="off"
      showClearButton={props.value !== ""}
      onClearClick={() => props.onChange("")}
      data-action={props.action}
    />
  )
}
