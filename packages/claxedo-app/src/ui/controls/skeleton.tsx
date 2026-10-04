import "./skeleton.css"

export function SkeletonBar(props: { readonly width: string; readonly class?: string }) {
  return <div class={props.class ? `ui-skeleton-bar ${props.class}` : "ui-skeleton-bar"} style={{ width: props.width }} />
}
