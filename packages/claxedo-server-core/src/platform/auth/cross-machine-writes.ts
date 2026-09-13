/**
 * "Agents may act on my other machines" — the account setting that decides
 * whether something an agent starts is allowed to leave the workspace its own
 * session runs in.
 *
 * It is off by default and no deployment stores it yet, so this is the one
 * place that fact is written down: the first-party MCP mount reads the same
 * answer per runtime credential (`FirstPartyMcpOptions.crossMachineWrites`),
 * and a Tasks root capability reads it here before it grants `start`. A
 * composition that begins storing the setting supplies one reader and both
 * halves follow.
 */
export type CrossMachineWritesAccount = Readonly<{ userId: string; orgId: string }>

export type CrossMachineWrites = (account: CrossMachineWritesAccount) => boolean | Promise<boolean>

export const crossMachineWritesOff: CrossMachineWrites = () => false
