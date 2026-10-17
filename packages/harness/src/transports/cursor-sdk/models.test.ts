import { expect, test } from "bun:test"
import { cursorAccountOptions, cursorApiModels } from "./models"

const listed = { items: [
  { id: "composer-2.5", displayName: "Composer 2.5", description: "Cursor's agent model", parameters: [] },
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { displayName: "No id" },
  "not a row",
] }

test("Cursor's /v1/models answer reads as its rows by id, display name and description, skipping rows without an id", () => {
  expect(cursorApiModels(listed)).toEqual([
    { id: "composer-2.5", name: "Composer 2.5", description: "Cursor's agent model" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  ])
  expect(cursorApiModels({})).toEqual([])
  expect(cursorApiModels("refused")).toEqual([])
})

test("an account's Cursor models list Auto first, selected unless the draft names a listed model", () => {
  const models = cursorApiModels(listed)
  const select = (model?: string) => cursorAccountOptions(models, model).options.find((option) => option.category === "model")
  expect(select()?.selectOptions?.map((row) => row.id)).toEqual(["auto", "composer-2.5", "claude-opus-5-5"])
  expect(select()?.currentValue).toBe("auto")
  expect(select("composer-2.5")?.currentValue).toBe("composer-2.5")
  expect(select("retired-model")?.currentValue).toBe("auto")
  expect(cursorAccountOptions([]).options).toEqual([])
})
