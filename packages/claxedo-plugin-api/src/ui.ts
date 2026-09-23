import type { Component, JSX } from "solid-js"

export type ToastInput = {
  readonly title: string
  readonly description?: string
  readonly tone?: "neutral" | "success" | "danger"
}

export type ConfirmInput = {
  readonly title: string
  readonly description?: string
  readonly confirmLabel?: string
  readonly danger?: boolean
}

export type ButtonProps = {
  readonly variant?: "neutral" | "danger" | "outline" | "ghost" | "contrast"
  readonly size?: "small" | "normal" | "large"
  readonly icon?: string
  readonly disabled?: boolean
  readonly type?: "button" | "submit"
  readonly class?: string
  readonly "aria-label"?: string
  readonly "data-testid"?: string
  readonly onClick?: (event: MouseEvent) => void
  readonly children?: JSX.Element
}

export type IconButtonProps = {
  readonly icon: string
  readonly label: string
  readonly size?: "small" | "normal" | "large"
  readonly variant?: "neutral" | "ghost" | "danger"
  readonly disabled?: boolean
  readonly class?: string
  readonly "data-testid"?: string
  readonly onClick?: (event: MouseEvent) => void
}

export type IconProps = { readonly name: string; readonly size?: "small" | "normal" | "large"; readonly class?: string }

export type TextInputProps = {
  readonly value: string
  readonly onInput: (value: string) => void
  readonly label?: string
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly autofocus?: boolean
  readonly error?: string
  readonly class?: string
  readonly "aria-label"?: string
  readonly "data-testid"?: string
  readonly onKeyDown?: (event: KeyboardEvent) => void
}

export type TextareaProps = TextInputProps & { readonly rows?: number }

export type SelectOption = { readonly value: string; readonly label: string; readonly disabled?: boolean }

export type SelectProps = {
  readonly value: string | undefined
  readonly options: readonly SelectOption[]
  readonly onChange: (value: string) => void
  readonly label?: string
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly class?: string
  readonly "aria-label"?: string
  readonly "data-testid"?: string
}

export type SwitchProps = {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly disabled?: boolean
  readonly "data-testid"?: string
}

export type TabsProps = {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly tabs: readonly { readonly value: string; readonly label: string }[]
  readonly "aria-label": string
}

export type MenuItem = {
  readonly id: string
  readonly label: string
  readonly icon?: string
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
}

export type MenuProps = {
  readonly items: readonly MenuItem[]
  readonly label: string
  readonly trigger: JSX.Element
  readonly "data-testid"?: string
}

export type DialogProps = {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly description?: string
  readonly footer?: JSX.Element
  readonly children?: JSX.Element
  readonly "data-testid"?: string
}

export type BadgeProps = { readonly tone?: "neutral" | "success" | "warning" | "danger"; readonly children?: JSX.Element }

export type TooltipProps = { readonly label: string; readonly children: JSX.Element }

export type LoaderProps = { readonly label: string }

export type PluginComponents = {
  readonly Button: Component<ButtonProps>
  readonly IconButton: Component<IconButtonProps>
  readonly Icon: Component<IconProps>
  readonly TextInput: Component<TextInputProps>
  readonly Textarea: Component<TextareaProps>
  readonly Select: Component<SelectProps>
  readonly Switch: Component<SwitchProps>
  readonly Tabs: Component<TabsProps>
  readonly Menu: Component<MenuProps>
  readonly Dialog: Component<DialogProps>
  readonly Badge: Component<BadgeProps>
  readonly Tooltip: Component<TooltipProps>
  readonly Loader: Component<LoaderProps>
}

export type PluginUi = {
  readonly toast: (input: ToastInput) => void
  readonly confirm: (input: ConfirmInput) => Promise<boolean>
  readonly components: PluginComponents
}
