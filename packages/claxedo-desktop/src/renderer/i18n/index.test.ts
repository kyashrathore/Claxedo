import { describe, expect, test } from "bun:test"

describe("desktop renderer i18n", () => {
  test("answers in English until the stored locale's dictionaries have loaded", async () => {
    const reads: string[][] = []
    Object.assign(globalThis, {
      window: {
        api: {
          storeGet: async (file: string, key: string) => {
            reads.push([file, key])
            return JSON.stringify({ locale: "zh" })
          },
        },
      },
    })
    const { initI18n, t } = await import("./index")

    expect(t("desktop.dialog.chooseFolder")).toBe("Choose a folder")

    const pending = initI18n()
    expect(initI18n()).toBe(pending)
    expect(await pending).toBe("zh")
    expect(reads).toEqual([["claxedo.global.dat", "language"]])
    expect(t("desktop.dialog.chooseFolder")).toBe("选择文件夹")
    expect(t("error.chain.unknown")).not.toBe("")
  })
})
