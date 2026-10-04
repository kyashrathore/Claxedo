import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const dir = import.meta.dir

function css(file: string) {
  return readFileSync(`${dir}/${file}`, "utf8")
}

describe("radio list", () => {
  test("is its own module, not a second component under the segmented control's name", async () => {
    const segmented = await import("./radio-group")
    const list = await import("./radio-list")

    expect(Object.keys(segmented).sort()).toEqual(["RadioGroup"])
    expect(Object.keys(list).sort()).toEqual(["RadioList", "RadioListItem"])
  })

  test("carries its own stylesheet, and the package's styles entry pulls it in", () => {
    expect(css("radio-list.css")).toContain(".ui-radio-list-item")
    expect(css("radio-group.css")).not.toContain(".ui-radio-list")
    expect(readFileSync(`${dir}/../styles/index.css`, "utf8"))
      .toContain('@import "../components/radio-list.css"')
  })

  test("a row that is not a choice reads as one: the words fade, not only the cursor", () => {
    const disabled = css("radio-list.css").split("&[data-disabled] {")[1]?.split("\n  }\n")[0] ?? ""

    expect(disabled).toContain(".ui-radio-list-item-text")
    expect(disabled).toContain("opacity")
  })
})
