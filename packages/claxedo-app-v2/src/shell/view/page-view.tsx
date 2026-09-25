import type { JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { RouteParams } from "../routes"
import type { PageEntry } from "../types"
import { Region } from "./region"

export type PageViewProps = { readonly page: PageEntry; readonly params: RouteParams }

export function PageView(props: PageViewProps): JSX.Element {
  return (
    <div class="shell-page" data-page={props.page.id} data-testid={`page-${props.page.id}`}>
      <Region name="page">
        <Dynamic component={props.page.view} params={props.params} />
      </Region>
    </div>
  )
}
