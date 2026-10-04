import { createUniqueId, Show, type JSX, type ParentProps } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import "./form-surface.css"

export type FormSurfaceProps = ParentProps<{
  readonly title: string
  readonly description?: JSX.Element
  readonly submitLabel: string
  readonly busyLabel: string
  readonly cancelLabel: string
  readonly busy: boolean
  readonly canSubmit?: boolean
  readonly error?: string
  readonly onSubmit: () => void
  readonly onCancel: () => void
}>

function SurfaceForm(props: FormSurfaceProps): JSX.Element {
  const formId = createUniqueId()
  return (
    <>
      <DialogHeader>
        <DialogTitleGroup title={props.title} description={props.description} />
      </DialogHeader>
      <DialogBody class="form-surface-body">
        <form
          id={formId}
          class="form-surface-fields"
          onSubmit={(event) => {
            event.preventDefault()
            if (!props.busy && props.canSubmit !== false) props.onSubmit()
          }}
        >
          {props.children}
          <Show when={props.error}>
            {(error) => (
              <p class="form-surface-error" role="alert">
                {error()}
              </p>
            )}
          </Show>
        </form>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="ghost" onClick={() => props.onCancel()}>
          {props.cancelLabel}
        </ButtonV2>
        <ButtonV2 type="submit" form={formId} variant="contrast" disabled={props.busy || props.canSubmit === false}>
          {props.busy ? props.busyLabel : props.submitLabel}
        </ButtonV2>
      </DialogFooter>
    </>
  )
}

export function FormDialog(props: FormSurfaceProps): JSX.Element {
  return (
    <DialogV2 fit aria-label={props.title}>
      <SurfaceForm {...props} />
    </DialogV2>
  )
}

export function FormDrawer(props: FormSurfaceProps): JSX.Element {
  return (
    <DialogV2 containerClass="form-drawer" aria-label={props.title}>
      <SurfaceForm {...props} />
    </DialogV2>
  )
}
