import { Icon } from "@/ui"
import { Show, splitProps, type JSX } from "solid-js"
import { installLineCommentStyles } from "./line-comment-styles"
import { useTranscriptI18n } from "./i18n"

installLineCommentStyles()

type LineCommentVariant = "default" | "editor"

function InlineGlyph() {
  return (
    <svg data-slot="line-comment-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16.25 3.75H3.75V16.25L6.875 14.4643H16.25V3.75Z" stroke="currentColor" stroke-linecap="square" />
    </svg>
  )
}

export type LineCommentAnchorProps = {
  id?: string
  top?: number
  inline?: boolean
  hideButton?: boolean
  open: boolean
  variant?: LineCommentVariant
  buttonLabel?: string
  onClick?: JSX.EventHandlerWithOptionsUnion<HTMLElement, MouseEvent>
  onMouseEnter?: JSX.EventHandlerWithOptionsUnion<HTMLElement, MouseEvent>
  onPopoverFocusOut?: JSX.EventHandlerWithOptionsUnion<HTMLDivElement, FocusEvent>
  class?: string
  popoverClass?: string
  children?: JSX.Element
}

export const LineCommentAnchor = (props: LineCommentAnchorProps) => {
  const hidden = () => !props.inline && props.top === undefined
  const variant = () => props.variant ?? "default"
  const inlineBody = () => props.inline && props.hideButton

  return (
    <div
      data-component="line-comment"
      data-prevent-autofocus=""
      data-variant={variant()}
      data-comment-id={props.id}
      data-open={props.open ? "" : undefined}
      data-inline={props.inline ? "" : undefined}
      classList={{
        [props.class ?? ""]: !!props.class,
      }}
      style={
        props.inline
          ? undefined
          : {
              top: `${props.top ?? 0}px`,
              opacity: hidden() ? 0 : 1,
              "pointer-events": hidden() ? "none" : "auto",
            }
      }
    >
      <Show
        when={inlineBody()}
        fallback={
          <>
            <button
              type="button"
              aria-label={props.buttonLabel}
              data-slot="line-comment-button"
              on:mousedown={(e) => e.stopPropagation()}
              on:mouseup={(e) => e.stopPropagation()}
              on:click={props.onClick}
              on:mouseenter={props.onMouseEnter}
            >
              <Show
                when={props.inline}
                fallback={<Icon name="comment" size="small" />}
              >
                <InlineGlyph />
              </Show>
            </button>
            <Show when={props.open}>
              <div
                data-slot="line-comment-popover"
                classList={{
                  [props.popoverClass ?? ""]: !!props.popoverClass,
                }}
                on:mousedown={(e) => e.stopPropagation()}
                on:focusout={props.onPopoverFocusOut}
              >
                {props.children}
              </div>
            </Show>
          </>
        }
      >
        <div
          data-slot="line-comment-popover"
          data-inline-body=""
          classList={{
            [props.popoverClass ?? ""]: !!props.popoverClass,
          }}
          on:mousedown={(e) => e.stopPropagation()}
          on:click={props.onClick}
          on:mouseenter={props.onMouseEnter}
          on:focusout={props.onPopoverFocusOut}
        >
          {props.children}
        </div>
      </Show>
    </div>
  )
}

type LineCommentProps = Omit<LineCommentAnchorProps, "children" | "variant"> & {
  comment: JSX.Element
  selection: JSX.Element
  actions?: JSX.Element
}

export const LineComment = (props: LineCommentProps) => {
  const i18n = useTranscriptI18n()
  const [split, rest] = splitProps(props, ["comment", "selection", "actions"])

  return (
    <LineCommentAnchor {...rest} variant="default" hideButton={props.inline}>
      <div data-slot="line-comment-content">
        <div data-slot="line-comment-head">
          <div data-slot="line-comment-text">{split.comment}</div>
          <Show when={split.actions}>
            <div data-slot="line-comment-tools">{split.actions}</div>
          </Show>
        </div>
        <div data-slot="line-comment-label">
          {i18n.t("transcript.lineComment.label.prefix")}
          {split.selection}
          {i18n.t("transcript.lineComment.label.suffix")}
        </div>
      </div>
    </LineCommentAnchor>
  )
}
