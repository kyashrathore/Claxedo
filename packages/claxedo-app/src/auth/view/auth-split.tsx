import type { JSX } from "solid-js"
import { ArtworkPlate } from "@/ui"

export function AuthSplit(props: { readonly title: string; readonly lead: string; readonly children: JSX.Element }) {
  return (
    <main class="auth-split">
      <div class="auth-split-art">
        <ArtworkPlate class="auth-split-plate" />
      </div>
      <section class="auth-split-panel">
        <div class="auth-split-column">
          <h1 class="auth-split-title">{props.title}</h1>
          <p class="auth-split-lead">{props.lead}</p>
          {props.children}
        </div>
      </section>
    </main>
  )
}
