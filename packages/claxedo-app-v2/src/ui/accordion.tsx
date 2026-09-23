import { Accordion as Kobalte } from "@kobalte/core/accordion"
import { Show, splitProps, type Component, type ComponentProps, type ParentProps } from "solid-js"
import "./accordion.css"

const ChevronDown: Component = () => (
  <svg
    data-slot="accordion-chevron" class="ui-accordion-chevron"
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

export interface AccordionProps extends ComponentProps<typeof Kobalte> {}
export interface AccordionItemProps extends ComponentProps<typeof Kobalte.Item> {}
export interface AccordionHeaderProps extends ComponentProps<typeof Kobalte.Header> {}
export interface AccordionTriggerProps extends ComponentProps<typeof Kobalte.Trigger> {
  hideChevron?: boolean
}
export interface AccordionContentProps extends ComponentProps<typeof Kobalte.Content> {}

function AccordionRoot(props: ParentProps<AccordionProps>) {
  const [s, r] = splitProps(props, ["class", "classList"])
  return <Kobalte {...r} data-component="accordion" classList={{ ...s.classList, [s.class ?? ""]: !!s.class }} />
}

function AccordionItem(props: ParentProps<AccordionItemProps>) {
  const [s, r] = splitProps(props, ["class", "classList"])
  return (
    <Kobalte.Item
      {...r}
      data-component="accordion-item"
      classList={{ "ui-accordion-item": true, ...s.classList, [s.class ?? ""]: !!s.class }}
    />
  )
}

function AccordionHeader(props: ParentProps<AccordionHeaderProps>) {
  const [s, r] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Header {...r} data-slot="accordion-header" classList={{ ...s.classList, [s.class ?? ""]: !!s.class }}>
      {s.children}
    </Kobalte.Header>
  )
}

function AccordionTrigger(props: ParentProps<AccordionTriggerProps>) {
  const [s, r] = splitProps(props, ["class", "classList", "children", "hideChevron"])
  return (
    <Kobalte.Trigger
      {...r}
      data-component="accordion-trigger"
      classList={{ "ui-accordion-trigger": true, ...s.classList, [s.class ?? ""]: !!s.class }}
    >
      <span data-slot="accordion-trigger-content">{s.children}</span>
      <Show when={!s.hideChevron}>
        <ChevronDown />
      </Show>
    </Kobalte.Trigger>
  )
}

function AccordionContent(props: ParentProps<AccordionContentProps>) {
  const [s, r] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Content
      {...r}
      data-component="accordion-content"
      classList={{ "ui-accordion-content": true, ...s.classList, [s.class ?? ""]: !!s.class }}
    >
      <div data-slot="accordion-content-inner">{s.children}</div>
    </Kobalte.Content>
  )
}

export const Accordion = Object.assign(AccordionRoot, {
  Item: AccordionItem,
  Header: AccordionHeader,
  Trigger: AccordionTrigger,
  Content: AccordionContent,
})
