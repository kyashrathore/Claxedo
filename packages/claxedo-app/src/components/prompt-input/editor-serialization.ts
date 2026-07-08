import {
  DEFAULT_PROMPT,
  type AgentPart,
  type FileAttachmentPart,
  type Prompt,
} from "@/context/prompt"
import type { FileSelection } from "@/context/file"
import { createTextFragment } from "@/components/prompt-input/editor-dom"

export function createPromptPill(part: FileAttachmentPart | AgentPart) {
  const pill = document.createElement("span")
  pill.textContent = part.content
  pill.setAttribute("data-type", part.type)
  if (part.type === "file") {
    pill.setAttribute("data-path", part.path)
    if (part.selection) {
      pill.setAttribute("data-selection-start-line", String(part.selection.startLine))
      pill.setAttribute("data-selection-start-char", String(part.selection.startChar))
      pill.setAttribute("data-selection-end-line", String(part.selection.endLine))
      pill.setAttribute("data-selection-end-char", String(part.selection.endChar))
    }
  }
  if (part.type === "agent") pill.setAttribute("data-name", part.name)
  pill.setAttribute("contenteditable", "false")
  pill.style.userSelect = "text"
  pill.style.cursor = "default"
  return pill
}

export function isNormalizedPromptEditor(editor: HTMLElement) {
  return Array.from(editor.childNodes).every((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ""
      if (!text.includes("\u200B")) return true
      if (text !== "\u200B") return false

      const prev = node.previousSibling
      const next = node.nextSibling
      const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
      return !!prevIsBr && !next
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    const el = node as HTMLElement
    if (el.dataset.type === "file") return !!el.dataset.path && hasValidSelectionDataset(el)
    if (el.dataset.type === "agent") return !!el.dataset.name
    return el.tagName === "BR"
  })
}

export function renderPromptEditor(editor: HTMLElement, parts: Prompt) {
  while (editor.firstChild) editor.removeChild(editor.firstChild)
  for (const part of parts) {
    if (part.type === "text") {
      editor.appendChild(createTextFragment(part.content))
      continue
    }
    if (part.type === "file" || part.type === "agent") {
      editor.appendChild(createPromptPill(part))
    }
  }

  const last = editor.lastChild
  if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
    editor.appendChild(document.createTextNode("\u200B"))
  }
}

export function parsePromptEditor(editor: HTMLElement): Prompt {
  const parts: Prompt = []
  let position = 0
  let buffer = ""

  const flushText = () => {
    let content = buffer
    if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
    if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
    buffer = ""
    if (!content) return
    parts.push({ type: "text", content, start: position, end: position + content.length })
    position += content.length
  }

  const pushFile = (file: HTMLElement) => {
    const content = file.textContent ?? ""
    parts.push({
      type: "file",
      path: file.dataset.path!,
      selection: readFileSelection(file),
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const pushAgent = (agent: HTMLElement) => {
    const content = agent.textContent ?? ""
    parts.push({
      type: "agent",
      name: agent.dataset.name!,
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent ?? ""
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const el = node as HTMLElement
    if (el.dataset.type === "file") {
      flushText()
      pushFile(el)
      return
    }
    if (el.dataset.type === "agent") {
      flushText()
      pushAgent(el)
      return
    }
    if (el.tagName === "BR") {
      buffer += "\n"
      return
    }

    for (const child of Array.from(el.childNodes)) {
      visit(child)
    }
  }

  const children = Array.from(editor.childNodes)
  children.forEach((child, index) => {
    const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
    visit(child)
    if (isBlock && index < children.length - 1) {
      buffer += "\n"
    }
  })

  flushText()

  if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
  return parts
}

function hasValidSelectionDataset(file: HTMLElement) {
  const values = fileSelectionValues(file)
  if (values.every((value) => value === undefined)) return true
  return values.every((value) => value !== undefined && value !== "" && Number.isFinite(Number(value)))
}

function readFileSelection(file: HTMLElement): FileSelection | undefined {
  const values = fileSelectionValues(file)
  if (values.every((value) => value === undefined)) return undefined
  const [startLine, startChar, endLine, endChar] = values.map(Number)
  if (![startLine, startChar, endLine, endChar].every(Number.isFinite)) return undefined
  return { startLine, startChar, endLine, endChar }
}

function fileSelectionValues(file: HTMLElement) {
  return [
    file.dataset.selectionStartLine,
    file.dataset.selectionStartChar,
    file.dataset.selectionEndLine,
    file.dataset.selectionEndChar,
  ]
}
