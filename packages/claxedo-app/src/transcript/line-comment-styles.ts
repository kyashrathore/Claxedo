export const lineCommentStyles = `
[data-annotation-slot] {
  padding: 12px;
  box-sizing: border-box;
}

[data-component="line-comment"] {
  position: absolute;
  right: 24px;
  z-index: var(--line-comment-z, 30);
}

[data-component="line-comment"][data-inline] {
  position: relative;
  right: auto;
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: flex-start;
}

[data-component="line-comment"][data-open] {
  z-index: var(--line-comment-open-z, 100);
}

[data-component="line-comment"] [data-slot="line-comment-button"] {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--icon-interactive-base);
  box-shadow: var(--shadow-xs);
  cursor: default;
  border: none;
}

[data-component="line-comment"] [data-component="icon"] {
  color: var(--icon-on-interactive-base);
}

[data-component="line-comment"] [data-slot="line-comment-icon"] {
  width: 12px;
  height: 12px;
  color: var(--icon-on-interactive-base);
}

[data-component="line-comment"] [data-slot="line-comment-button"]:focus {
  outline: none;
}

[data-component="line-comment"] [data-slot="line-comment-button"]:focus-visible {
  box-shadow: var(--shadow-xs-border-focus);
}

[data-component="line-comment"] [data-slot="line-comment-popover"] {
  position: absolute;
  top: calc(100% + 4px);
  right: -8px;
  z-index: var(--line-comment-popover-z, 40);
  min-width: 200px;
  max-width: none;
  box-sizing: border-box;
  border-radius: var(--radius-lg);
  background: var(--surface-raised-stronger-non-alpha);
  box-shadow: var(--shadow-xxs-border);
  padding: 12px;
}

[data-component="line-comment"][data-inline] [data-slot="line-comment-popover"] {
  position: relative;
  top: auto;
  right: auto;
  margin-left: 8px;
  flex: 1 1 0%;
  width: auto;
  max-width: 100%;
  min-width: 0;
}

[data-component="line-comment"][data-inline] [data-slot="line-comment-popover"][data-inline-body] {
  margin-left: 0;
}

[data-component="line-comment"][data-inline][data-variant="default"] [data-slot="line-comment-popover"][data-inline-body] {
  cursor: pointer;
}

[data-component="line-comment"][data-variant="editor"] [data-slot="line-comment-popover"] {
  width: 380px;
  max-width: none;
  padding: 6px;
  border-radius: 20px;
  background: var(--v2-background-bg-base);
  box-shadow: var(--v2-elevation-raised);
}

[data-component="line-comment"][data-inline][data-variant="editor"] [data-slot="line-comment-popover"] {
  width: 100%;
}

[data-component="line-comment"] [data-slot="line-comment-content"] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-head"] {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-text"] {
  flex: 1;
  min-width: 0;
  font-family: var(--font-family-sans);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-regular);
  line-height: var(--line-height-x-large);
  letter-spacing: var(--letter-spacing-normal);
  color: var(--text-strong);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

[data-component="line-comment"] [data-slot="line-comment-tools"] {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-label"] {
  font-family: var(--font-family-sans);
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-large);
  letter-spacing: var(--letter-spacing-normal);
  color: var(--text-weak);
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

[data-component="line-comment"] [data-slot="line-comment-editor"] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-field"] {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-textarea"] {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  max-height: 200px;
  overflow-y: auto;
  resize: none;
  padding: 6px 0 6px 10px;
  border: 0;
  background: transparent;
  color: var(--v2-text-text-base);
  font-family: var(--font-family-sans);
  font-size: var(--font-size-base);
  line-height: 20px;
  outline: none;
}

[data-component="line-comment"] [data-slot="line-comment-textarea"]::placeholder {
  color: var(--text-weak);
}

[data-component="line-comment"] [data-slot="line-comment-submit"] {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 9999px;
  background: var(--v2-background-bg-inverse);
  color: var(--v2-icon-icon-inverse);
  transition: opacity 150ms;
}

[data-component="line-comment"] [data-slot="line-comment-submit"] [data-component="icon"] {
  color: inherit;
}

[data-component="line-comment"] [data-slot="line-comment-submit"]:hover {
  opacity: 0.9;
}

[data-component="line-comment"] [data-slot="line-comment-submit"]:disabled {
  opacity: 0.35;
}

[data-component="line-comment"] [data-slot="line-comment-submit"]:focus-visible {
  outline: none;
  box-shadow: var(--shadow-xs-border-focus);
}

[data-component="line-comment"] [data-slot="line-comment-mention-list"] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  background: var(--surface-base);
}

[data-component="line-comment"] [data-slot="line-comment-mention-item"] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-strong);
  text-align: left;
}

[data-component="line-comment"] [data-slot="line-comment-mention-item"][data-active] {
  background: var(--surface-raised-base-hover);
}

[data-component="line-comment"] [data-slot="line-comment-mention-path"] {
  display: flex;
  align-items: center;
  min-width: 0;
  font-family: var(--font-family-sans);
  font-size: var(--font-size-small);
  line-height: var(--line-height-large);
}

[data-component="line-comment"] [data-slot="line-comment-mention-dir"] {
  min-width: 0;
  color: var(--text-weak);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-component="line-comment"] [data-slot="line-comment-mention-file"] {
  color: var(--text-strong);
  white-space: nowrap;
}
`

let installed = false

export function installLineCommentStyles() {
  if (installed) return
  if (typeof document === "undefined") return

  const id = "opencode-line-comment-styles"
  if (document.getElementById(id)) {
    installed = true
    return
  }

  const style = document.createElement("style")
  style.id = id
  style.textContent = lineCommentStyles
  document.head.appendChild(style)
  installed = true
}
