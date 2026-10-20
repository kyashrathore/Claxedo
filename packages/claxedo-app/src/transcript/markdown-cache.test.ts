/// <reference types="bun" />
import { expect, test } from "bun:test"
import { sanitizeSvg } from "./markdown-cache"

type SvgSanitizeConfig = Parameters<NonNullable<Parameters<typeof sanitizeSvg>[1]>["sanitize"]>[1]

function recordingPurifier() {
  const configs: SvgSanitizeConfig[] = []
  return {
    configs,
    purifier: {
      isSupported: true,
      sanitize: (source: string, config: SvgSanitizeConfig) => {
        configs.push(config)
        return source
      },
    },
  }
}

test("a diagram's SVG keeps no style element, so its CSS cannot restyle or overlay the app", () => {
  const { configs, purifier } = recordingPurifier()
  sanitizeSvg("<svg><style>body{display:none}</style></svg>", purifier)
  const [config] = configs
  expect(config?.FORBID_TAGS).toContain("style")
  expect(config?.FORBID_CONTENTS).toContain("style")
  expect(config).not.toHaveProperty("ADD_TAGS")
})
