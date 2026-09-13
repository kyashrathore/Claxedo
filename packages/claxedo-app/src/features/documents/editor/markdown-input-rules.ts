import { Extension, InputRule, wrappingInputRule } from "@tiptap/core"
import type { MarkType } from "@tiptap/pm/model"

/**
 * The markdown syntax Tiptap's bundled extensions do not convert as you type.
 *
 * These sit beside the upstream rules rather than replacing them: emphasis,
 * headings, bullets, fences, rules and task items already convert. What is
 * left are the constructs whose rule upstream never shipped (a link) and the
 * one whose regex is narrower than the parser it has to agree with (`1)`).
 */

/**
 * `[text](href)`, completed by the closing bracket. The lookbehind keeps it off
 * `![alt](src)`, which is an image and whose own rule would otherwise never see
 * the syntax.
 */
export const LINK_INPUT_REGEX = /(?<!!)\[([^[\]]+)]\(([^\s()]+)\)$/

/**
 * Written out rather than built with `markInputRule`, which keeps the LAST
 * capture group as the visible text — for a link that is the href.
 */
export function markdownLinkInputRule(type: MarkType) {
  return new InputRule({
    find: LINK_INPUT_REGEX,
    handler: ({ state, range, match }) => {
      const text = match[1]
      const href = match[2]
      if (!text || !href) return null
      state.tr
        .replaceWith(range.from, range.to, state.schema.text(text))
        .addMark(range.from, range.from + text.length, type.create({ href }))
        // Without this the mark stays active and the next character typed
        // joins the link.
        .removeStoredMark(type)
      return undefined
    },
  })
}

/** The `1)` spelling of an ordered list, which the parser reads and the bundled rule does not. */
export const ORDERED_LIST_PAREN_REGEX = /^(\d+)\)\s$/

export const OrderedListParenInput = Extension.create({
  name: "orderedListParenInput",

  addInputRules() {
    const type = this.editor.schema.nodes.orderedList
    if (!type) return []
    return [
      wrappingInputRule({
        find: ORDERED_LIST_PAREN_REGEX,
        type,
        getAttributes: (match) => ({ start: Number(match[1]) }),
        joinPredicate: (match, node) =>
          (!node.attrs.type || node.attrs.type === "1") && node.childCount + node.attrs.start === Number(match[1]),
      }),
    ]
  },
})
