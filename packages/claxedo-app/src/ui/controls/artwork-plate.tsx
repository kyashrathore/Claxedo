import "./artwork-plate.css"

export function ArtworkPlate(props: { readonly class?: string }) {
  return <div class={props.class ? `ui-artwork-plate ${props.class}` : "ui-artwork-plate"} aria-hidden="true" />
}
