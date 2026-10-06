import "./artwork-plate.css"

export function ArtworkPlate(props: { readonly class?: string; readonly thinned?: boolean }) {
  return <div class={props.class ? `ui-artwork-plate ${props.class}` : "ui-artwork-plate"} data-thinned={props.thinned ? "" : undefined} aria-hidden="true" />
}
