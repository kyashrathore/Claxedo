import type { AgentPart, FilePart, FileSelection, Prompt } from "../model"
import { emptyPrompt } from "../model"
import { asElement, createTextFragment, isBreakNode } from "./dom"

export function createPromptPill(part: FilePart | AgentPart) {
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

  if (isBreakNode(editor.lastChild)) {
    editor.appendChild(document.createTextNode("​"))
  }
}

type Parser = { parts: Prompt; position: number; buffer: string }

function flushText(parser: Parser): void {
  let content = parser.buffer
  if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
  if (content.includes("​")) content = content.replace(/​/g, "")
  parser.buffer = ""
  if (!content) return
  parser.parts.push({ type: "text", content, start: parser.position, end: parser.position + content.length })
  parser.position += content.length
}

function pushPill(parser: Parser, element: HTMLElement): void {
  flushText(parser)
  const content = element.textContent ?? ""
  const span = { content, start: parser.position, end: parser.position + content.length }
  if (element.dataset.type === "file") {
    parser.parts.push({ type: "file", path: element.dataset.path ?? "", selection: readFileSelection(element), ...span })
  } else {
    parser.parts.push({ type: "agent", name: element.dataset.name ?? "", ...span })
  }
  parser.position += content.length
}

function visit(parser: Parser, node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parser.buffer += node.textContent ?? ""
    return
  }
  const el = asElement(node)
  if (!el) return
  if (el.dataset.type === "file" || el.dataset.type === "agent") return pushPill(parser, el)
  if (el.tagName === "BR") {
    parser.buffer += "\n"
    return
  }
  for (const child of Array.from(el.childNodes)) visit(parser, child)
}

export function parsePromptEditor(editor: HTMLElement): Prompt {
  const parser: Parser = { parts: [], position: 0, buffer: "" }
  const children = Array.from(editor.childNodes)
  children.forEach((child, index) => {
    const childTag = asElement(child)?.tagName
    visit(parser, child)
    if ((childTag === "DIV" || childTag === "P") && index < children.length - 1) parser.buffer += "\n"
  })
  flushText(parser)
  return parser.parts.length === 0 ? emptyPrompt() : parser.parts
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
