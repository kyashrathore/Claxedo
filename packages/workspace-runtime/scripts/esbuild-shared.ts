export const textLoaders = "--loader:.sh=text --loader:.txt=text"

export const commonJsBanner =
  `--banner:js="import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);"`

export function esbuildCommand(input: {
  entry: string
  outfile: string
  externals: string[]
}) {
  return [
    "bunx esbuild@0.25.12",
    input.entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${input.outfile}`,
    input.externals.map((item) => `--external:${item}`).join(" "),
    textLoaders,
    "--target=node22",
    "--main-fields=module,main",
    commonJsBanner,
  ].filter(Boolean).join(" ")
}
