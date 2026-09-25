import { splitProps, type ComponentProps, type ParentProps } from "solid-js"
import "./field.css"

export type FieldProps = ComponentProps<"div">

function FieldRoot(props: ParentProps<FieldProps>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <div
      {...rest}
      classList={{
        "v2-field": true,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </div>
  )
}

export type FieldLabelProps = Omit<ComponentProps<"label">, "for"> & { for: string }

function FieldLabel(props: ParentProps<FieldLabelProps>) {
  const [local, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <label
      {...rest}
      data-slot="v2-field-label"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <span data-slot="v2-field-label-text">{local.children}</span>
    </label>
  )
}

export const Field = Object.assign(FieldRoot, { Label: FieldLabel })
