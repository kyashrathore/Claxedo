import { Accordion as Kobalte } from "@kobalte/core/accordion"
import { Show, omit, type Component, type ParentProps } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import "./accordion-v2.css"

const ChevronDown: Component = () => (
  <svg
    data-slot="accordion-v2-chevron"
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path d="M4 5.5L7 8.5L10 5.5" stroke="currentColor" />
  </svg>
)

export interface AccordionV2Props extends ComponentProps<typeof Kobalte> {}
export interface AccordionV2ItemProps extends ComponentProps<typeof Kobalte.Item> {}
export interface AccordionV2HeaderProps extends ComponentProps<typeof Kobalte.Header> {}
export interface AccordionV2TriggerProps extends ComponentProps<typeof Kobalte.Trigger> {
  hideChevron?: boolean
}
export interface AccordionV2ContentProps extends ComponentProps<typeof Kobalte.Content> {}

function AccordionV2Root(props: ParentProps<AccordionV2Props>) {
  const s = props,
    r = omit(props, "class")
  return <Kobalte {...r} data-component="accordion-v2" class={s.class} />
}

function AccordionV2Item(props: ParentProps<AccordionV2ItemProps>) {
  const s = props,
    r = omit(props, "class")
  return <Kobalte.Item {...r} data-component="accordion-v2-item" class={s.class} />
}

function AccordionV2Header(props: ParentProps<AccordionV2HeaderProps>) {
  const s = props,
    r = omit(props, "class", "children")
  return (
    <Kobalte.Header {...r} data-slot="accordion-v2-header" class={s.class}>
      {s.children}
    </Kobalte.Header>
  )
}

function AccordionV2Trigger(props: ParentProps<AccordionV2TriggerProps>) {
  const s = props,
    r = omit(props, "class", "children", "hideChevron")
  return (
    <Kobalte.Trigger {...r} data-component="accordion-v2-trigger" class={s.class}>
      <span data-slot="accordion-v2-trigger-content">{s.children}</span>
      <Show when={!s.hideChevron}>
        <ChevronDown />
      </Show>
    </Kobalte.Trigger>
  )
}

function AccordionV2Content(props: ParentProps<AccordionV2ContentProps>) {
  const s = props,
    r = omit(props, "class", "children")
  return (
    <Kobalte.Content {...r} data-component="accordion-v2-content" class={s.class}>
      <div data-slot="accordion-v2-content-inner">{s.children}</div>
    </Kobalte.Content>
  )
}

export const AccordionV2 = Object.assign(AccordionV2Root, {
  Item: AccordionV2Item,
  Header: AccordionV2Header,
  Trigger: AccordionV2Trigger,
  Content: AccordionV2Content,
})
