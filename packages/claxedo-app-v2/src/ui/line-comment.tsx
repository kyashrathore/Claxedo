import { Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import "./line-comment.css"

export function LineCommentOverflowIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      {...props}
      width={props.width ?? 16}
      height={props.height ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={props["aria-hidden"] ?? "true"}
    >
      <path d="M2.5 7.5H3.5V8.5H2.5V7.5Z" stroke="currentColor" />
      <path d="M7.5 7.5H8.5V8.5H7.5V7.5Z" stroke="currentColor" />
      <path d="M12.5 7.5H13.5V8.5H12.5V7.5Z" stroke="currentColor" />
    </svg>
  )
}

export interface LineCommentProps extends ComponentProps<"div"> {
  comment: JSX.Element
  selection: JSX.Element
  actions?: JSX.Element
}

export function LineComment(props: LineCommentProps) {
  const [local, rest] = splitProps(props, ["comment", "selection", "actions", "class", "classList"])
  return (
    <div
      {...rest}
      data-component="v2-line-comment"
      data-variant="display"
      classList={{ ...local.classList, [local.class ?? ""]: !!local.class }}
    >
      <div data-slot="v2-line-comment-shell">
        <div data-slot="v2-line-comment-column">
          <div data-slot="v2-line-comment-text">{local.comment}</div>
          <div data-slot="v2-line-comment-meta">{local.selection}</div>
        </div>
        <Show when={local.actions}>{(actions) => <div data-slot="v2-line-comment-tools">{actions()}</div>}</Show>
      </div>
    </div>
  )
}

export { LineCommentEditor, type LineCommentEditorProps } from "./line-comment-editor"
export { type LineCommentEditorMention } from "./line-comment-mentions"
