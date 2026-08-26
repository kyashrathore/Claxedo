import { Tabs as Kobalte } from "@kobalte/core/tabs"
import { Show, omit } from "solid-js"
import type { JSX } from "@solidjs/web"
import type { ParentProps, Component } from "solid-js"
import type { ComponentProps } from "@solidjs/web"

export interface TabsProps extends ComponentProps<typeof Kobalte> {
  variant?: "normal" | "alt" | "pill" | "settings"
  orientation?: "horizontal" | "vertical"
}
export interface TabsListProps extends ComponentProps<typeof Kobalte.List> {}
export interface TabsTriggerProps extends ComponentProps<typeof Kobalte.Trigger> {
  classes?: {
    button?: string
  }
  hideCloseButton?: boolean
  closeButton?: JSX.Element
  onMiddleClick?: () => void
}
export interface TabsContentProps extends ComponentProps<typeof Kobalte.Content> {}

function TabsRoot(props: TabsProps) {
  const split = props,
    rest = omit(props, "class", "variant", "orientation")
  return (
    <Kobalte
      {...rest}
      orientation={split.orientation}
      data-component="tabs"
      data-variant={split.variant || "normal"}
      data-orientation={split.orientation || "horizontal"}
      class={["ui-tabs", split.class]}
    />
  )
}

function TabsList(props: TabsListProps) {
  const split = props,
    rest = omit(props, "class")
  return <Kobalte.List {...rest} data-slot="tabs-list" class={["ui-tabs-list", split.class]} />
}

function TabsTrigger(props: ParentProps<TabsTriggerProps>) {
  const split = props,
    rest = omit(props, "class", "classes", "children", "closeButton", "hideCloseButton", "onMiddleClick")
  return (
    <div
      data-slot="tabs-trigger-wrapper"
      data-value={props.value}
      class={["ui-tabs-trigger-wrapper", split.class]}
      onMouseDown={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
          split.onMiddleClick()
        }
      }}
    >
      <Kobalte.Trigger
        {...rest}
        data-slot="tabs-trigger"
        data-value={props.value}
        class={["ui-tabs-trigger", split.classes?.button]}
      >
        {split.children}
      </Kobalte.Trigger>
      <Show when={split.closeButton}>
        {(closeButton) => (
          <div
            data-slot="tabs-trigger-close-button"
            class="ui-tabs-trigger-close-button"
            data-hidden={split.hideCloseButton}
          >
            {closeButton()}
          </div>
        )}
      </Show>
    </div>
  )
}

function TabsContent(props: ParentProps<TabsContentProps>) {
  const split = props,
    rest = omit(props, "class", "children")
  return (
    <Kobalte.Content {...rest} data-slot="tabs-content" class={["ui-tabs-content", split.class]}>
      {split.children}
    </Kobalte.Content>
  )
}

const TabsSectionTitle: Component<ParentProps> = (props) => {
  return <div data-slot="tabs-section-title">{props.children}</div>
}

export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
  SectionTitle: TabsSectionTitle,
})
