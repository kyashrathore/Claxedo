export declare function runUnderStandInHome(packageDir: string, files: string[]): Promise<{
  code: number | null
  output: string
  written: string[]
}>
