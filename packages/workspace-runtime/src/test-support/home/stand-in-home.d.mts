export declare function runUnderStandInHome(packageDir: string, command: string[]): Promise<{
  code: number | null
  output: string
  written: string[]
}>
