import { createEffect, createUniqueId, type Component, type JSX } from "solid-js"

export const Modal: Component<{ open: boolean; title: string; onClose: () => void; children: JSX.Element }> = (props) => {
  const titleId = createUniqueId()
  let dialog!: HTMLDialogElement
  createEffect(() => {
    if (props.open && !dialog.open) dialog.showModal()
    if (!props.open && dialog.open) dialog.close()
  })
  return (
    <dialog ref={dialog} class="projects-dialog" aria-labelledby={titleId} onClose={() => props.onClose()}>
      <h2 id={titleId} class="m-0 mb-4 text-base font-semibold">
        {props.title}
      </h2>
      {props.children}
    </dialog>
  )
}
