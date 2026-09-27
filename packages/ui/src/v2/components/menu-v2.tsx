import { Button } from "@kobalte/core/button"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { ContextMenu } from "@kobalte/core/context-menu"
import {
  createContext,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
  splitProps,
  useContext,
  type Component,
  type ComponentProps,
  type JSX,
  type ParentProps,
} from "solid-js"
import { adoptElement } from "./adopt-element"
import "./menu-v2.css"

const ChevronRight: Component = () => (
  <svg
    data-slot="menu-v2-item-chevron"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path d="M6 4L10 8L6 12V4Z" fill="currentColor" />
  </svg>
)

const CheckMark: Component = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M3.53564 8.17857L6.39279 11.75L12.4642 4.25"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

function ItemBody(
  props: ParentProps<{
    shortcut?: JSX.Element | string
    badge?: JSX.Element | string
    trailing?: JSX.Element
  }>,
) {
  return (
    <>
      <span data-slot="menu-v2-item-content">{props.children}</span>
      <Show when={props.shortcut}>{(shortcut) => <span data-slot="menu-v2-item-shortcut">{shortcut()}</span>}</Show>
      <Show when={props.badge}>{(badge) => <span data-slot="menu-v2-item-badge">{badge()}</span>}</Show>
      {props.trailing}
    </>
  )
}

export interface MenuV2ItemProps extends ComponentProps<typeof DropdownMenu.Item> {
  shortcut?: JSX.Element | string
  badge?: JSX.Element | string
}

function MenuV2Item(props: ParentProps<MenuV2ItemProps>) {
  const [s, r] = splitProps(props, ["class", "classList", "children", "shortcut", "badge"])
  return (
    <DropdownMenu.Item {...r} data-component="menu-v2-item" classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}>
      <ItemBody shortcut={s.shortcut} badge={s.badge}>
        {s.children}
      </ItemBody>
    </DropdownMenu.Item>
  )
}

export interface MenuV2CheckboxItemProps extends ComponentProps<typeof DropdownMenu.CheckboxItem> {
  shortcut?: JSX.Element | string
  badge?: JSX.Element | string
}

function MenuV2CheckboxItem(props: ParentProps<MenuV2CheckboxItemProps>) {
  const [s, r] = splitProps(props, ["class", "classList", "children", "shortcut", "badge"])
  return (
    <DropdownMenu.CheckboxItem
      {...r}
      data-component="menu-v2-item"
      classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}
    >
      <ItemBody
        shortcut={s.shortcut}
        badge={s.badge}
        trailing={
          <DropdownMenu.ItemIndicator data-slot="menu-v2-item-indicator" forceMount>
            <CheckMark />
          </DropdownMenu.ItemIndicator>
        }
      >
        {s.children}
      </ItemBody>
    </DropdownMenu.CheckboxItem>
  )
}

export interface MenuV2RadioItemProps extends ComponentProps<typeof DropdownMenu.RadioItem> {
  shortcut?: JSX.Element | string
  badge?: JSX.Element | string
}

function MenuV2RadioItem(props: ParentProps<MenuV2RadioItemProps>) {
  const [s, r] = splitProps(props, ["class", "classList", "children", "shortcut", "badge"])
  return (
    <DropdownMenu.RadioItem
      {...r}
      data-component="menu-v2-item"
      classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}
    >
      <ItemBody
        shortcut={s.shortcut}
        badge={s.badge}
        trailing={
          <DropdownMenu.ItemIndicator data-slot="menu-v2-item-indicator" forceMount>
            <CheckMark />
          </DropdownMenu.ItemIndicator>
        }
      >
        {s.children}
      </ItemBody>
    </DropdownMenu.RadioItem>
  )
}

export interface MenuV2SubTriggerProps extends ComponentProps<typeof DropdownMenu.SubTrigger> {
  shortcut?: JSX.Element | string
  badge?: JSX.Element | string
}

function MenuV2SubTrigger(props: ParentProps<MenuV2SubTriggerProps>) {
  const [s, r] = splitProps(props, ["class", "classList", "children", "shortcut", "badge"])
  return (
    <DropdownMenu.SubTrigger
      {...r}
      data-component="menu-v2-item"
      classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}
    >
      <ItemBody shortcut={s.shortcut} badge={s.badge} trailing={<ChevronRight />}>
        {s.children}
      </ItemBody>
    </DropdownMenu.SubTrigger>
  )
}

function MenuV2SubContent(props: ComponentProps<typeof DropdownMenu.SubContent>) {
  const [s, r] = splitProps(props, ["class", "classList"])
  return (
    <DropdownMenu.SubContent
      {...r}
      data-component="menu-v2-content"
      classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}
    />
  )
}

function MenuV2GroupLabel(props: ComponentProps<typeof DropdownMenu.GroupLabel>) {
  const [s, r] = splitProps(props, ["class", "classList"])
  return (
    <DropdownMenu.GroupLabel
      {...r}
      data-slot="menu-v2-group-label"
      classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}
    />
  )
}

function MenuV2Separator(props: ComponentProps<typeof DropdownMenu.Separator>) {
  const [s, r] = splitProps(props, ["class", "classList"])
  return (
    <DropdownMenu.Separator
      {...r}
      data-slot="menu-v2-separator"
      classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}
    />
  )
}

function MenuV2Content(props: ComponentProps<typeof DropdownMenu.Content>) {
  const [s, r] = splitProps(props, ["class", "classList"])
  return (
    <DropdownMenu.Content
      {...r}
      data-component="menu-v2-content"
      classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}
    />
  )
}

type MenuV2Lazy = {
  readonly id: string
  readonly wake: () => void
  readonly setTrigger: (element: HTMLElement | undefined, props: ComponentProps<typeof DropdownMenu.Trigger> | undefined) => void
  readonly setPortal: (props: ComponentProps<typeof DropdownMenu.Portal> | undefined) => void
}

const MenuV2LazyContext = createContext<MenuV2Lazy>()

/**
 * A menu that has never opened is its trigger alone, drawn as Kobalte draws a
 * closed trigger. Kobalte's menu mounts on the trigger's first pointerenter or
 * focusin, which precede every pointerdown and keydown that can open it for
 * mouse, touch, pen and keyboard, so Kobalte receives the real press itself.
 */
function MenuV2Root(props: ComponentProps<typeof DropdownMenu>) {
  const [local, rootProps] = splitProps(props, ["children", "id"])
  const id = local.id ?? `dropdownmenu-${createUniqueId()}`
  const [live, setLive] = createSignal(props.open === true || props.defaultOpen === true)
  const [trigger, setTriggerState] = createSignal<{ element: HTMLElement | undefined; props: ComponentProps<typeof DropdownMenu.Trigger> }>()
  const [portal, setPortal] = createSignal<ComponentProps<typeof DropdownMenu.Portal>>()
  createEffect(() => {
    if (props.open) setLive(true)
  })
  const lazy: MenuV2Lazy = {
    id,
    wake: () => setLive(true),
    setTrigger: (element, triggerProps) => setTriggerState(triggerProps ? { element, props: triggerProps } : undefined),
    setPortal: (portalProps) => setPortal(() => portalProps),
  }
  return (
    <MenuV2LazyContext.Provider value={lazy}>
      {local.children}
      <Show when={live()}>
        <DropdownMenu {...rootProps} id={id}>
          <Show when={trigger()}>
            {(current) => {
              const [, triggerRest] = splitProps(current().props, ["children", "as", "ref"])
              return (
                <DropdownMenu.Trigger
                  {...triggerRest}
                  id={current().props.id ?? `${id}-trigger`}
                  as={adoptElement(() => current().element)}
                />
              )
            }}
          </Show>
          <Show when={portal()}>
            {(current) => {
              const [portalChildren, portalRest] = splitProps(current(), ["children"])
              return <DropdownMenu.Portal {...portalRest}>{portalChildren.children}</DropdownMenu.Portal>
            }}
          </Show>
        </DropdownMenu>
      </Show>
    </MenuV2LazyContext.Provider>
  )
}

function MenuV2Trigger(props: ComponentProps<typeof DropdownMenu.Trigger>) {
  const lazy = useContext(MenuV2LazyContext)
  if (!lazy) return <DropdownMenu.Trigger {...props} />
  const handlers = Object.keys(props).filter((key) => /^on[A-Z]/.test(key)) as (keyof typeof props)[]
  const [local, , rest] = splitProps(props, ["children", "ref"], handlers)
  lazy.setTrigger(undefined, props)
  onCleanup(() => lazy.setTrigger(undefined, undefined))
  return (
    <Button
      {...rest}
      ref={(node: HTMLElement) => {
        lazy.setTrigger(node, props)
        if (typeof local.ref === "function") (local.ref as (node: HTMLElement) => void)(node)
      }}
      id={props.id ?? `${lazy.id}-trigger`}
      aria-haspopup="true"
      aria-expanded={false}
      data-closed=""
      onPointerEnter={lazy.wake}
      onFocusIn={lazy.wake}
    >
      {local.children}
    </Button>
  )
}

function MenuV2Portal(props: ComponentProps<typeof DropdownMenu.Portal>) {
  const lazy = useContext(MenuV2LazyContext)
  if (!lazy) return <DropdownMenu.Portal {...props} />
  lazy.setPortal(props)
  onCleanup(() => lazy.setPortal(undefined))
  return undefined
}

function MenuV2ContextRoot(props: ComponentProps<typeof ContextMenu>) {
  return <ContextMenu {...props} />
}

function MenuV2ContextContent(props: ComponentProps<typeof ContextMenu.Content>) {
  const [s, r] = splitProps(props, ["class", "classList"])
  return (
    <ContextMenu.Content
      {...r}
      data-component="menu-v2-content"
      classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}
    />
  )
}

const MenuV2Context = Object.assign(MenuV2ContextRoot, {
  Trigger: ContextMenu.Trigger,
  Portal: ContextMenu.Portal,
  Content: MenuV2ContextContent,
})

export const MenuV2 = Object.assign(MenuV2Root, {
  Trigger: MenuV2Trigger as typeof DropdownMenu.Trigger,
  Portal: MenuV2Portal as typeof DropdownMenu.Portal,
  Content: MenuV2Content,
  Item: MenuV2Item,
  CheckboxItem: MenuV2CheckboxItem,
  RadioGroup: DropdownMenu.RadioGroup,
  RadioItem: MenuV2RadioItem,
  Group: DropdownMenu.Group,
  GroupLabel: MenuV2GroupLabel,
  Separator: MenuV2Separator,
  Sub: DropdownMenu.Sub,
  SubTrigger: MenuV2SubTrigger,
  SubContent: MenuV2SubContent,
  Context: MenuV2Context,
})
