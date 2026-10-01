import { splitProps, type JSX } from "solid-js"
import { ClaxedoIconButton } from "./claxedo-icon-button"

type SidePanelTabProps = JSX.HTMLAttributes<HTMLDivElement> & {
  readonly selected: boolean
  readonly label: string
  readonly icon: JSX.Element
  readonly closeLabel: string
  readonly onActivate?: () => void
  readonly onClose: () => void
  readonly closable: boolean
  readonly closeAttributes?: JSX.HTMLAttributes<HTMLDivElement> & {
    readonly [key: `data-${string}`]: string | undefined
  }
}

function TabCloseButton(props: {
  readonly label: string
  readonly visible: boolean
  readonly onClose: () => void
}): JSX.Element {
  return (
    <ClaxedoIconButton
      icon="close-small"
      variant="ghost"
      class="h-5 w-5 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100"
      classList={{
        "opacity-100 pointer-events-auto": props.visible,
        "opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100":
          !props.visible,
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
      aria-label={props.label}
    />
  )
}

export function SidePanelTab(props: SidePanelTabProps): JSX.Element {
  const [local, attributes] = splitProps(props, [
    "selected",
    "label",
    "icon",
    "closeLabel",
    "onActivate",
    "onClose",
    "closable",
    "closeAttributes",
  ])
  return (
    <div
      {...attributes}
      data-selected={local.selected ? "true" : undefined}
      class="group relative my-1 ml-0.5 flex h-7 max-w-[180px] shrink-0 items-center rounded-md border border-transparent text-13-medium transition-[background-color,color] duration-100 pointer-coarse:my-0 pointer-coarse:h-11"
      classList={{
        "bg-surface-base-hover text-text-base": local.selected,
        "text-text-weak hover:bg-surface-base-hover/35 hover:text-text-base": !local.selected,
      }}
    >
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 pr-7 leading-none pointer-coarse:pr-12"
        aria-current={local.selected ? "true" : undefined}
        onClick={() => local.onActivate?.()}
        onAuxClick={(event) => {
          if (event.button !== 1 || !local.closable) return
          event.preventDefault()
          local.onClose()
        }}
      >
        {local.icon}
        <span class="truncate">{local.label}</span>
      </button>
      <div class="absolute right-1 flex h-full items-center">
        <div {...local.closeAttributes} class="flex">
          <TabCloseButton label={local.closeLabel} visible={local.selected} onClose={local.onClose} />
        </div>
      </div>
    </div>
  )
}
