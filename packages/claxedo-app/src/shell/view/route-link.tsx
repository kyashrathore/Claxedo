import type { JSX } from "solid-js"
import { useShellRoute } from "../router"

export function RouteLink(props: {
  readonly href: string
  readonly class?: string
  readonly "aria-current"?: JSX.AnchorHTMLAttributes<HTMLAnchorElement>["aria-current"]
  readonly "aria-label"?: string
  readonly children: JSX.Element
}): JSX.Element {
  const routing = useShellRoute()
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    routing.navigate(props.href)
  }
  return (
    <a href={props.href} class={props.class} aria-current={props["aria-current"]} aria-label={props["aria-label"]} onClick={onClick}>
      {props.children}
    </a>
  )
}
