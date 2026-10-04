/**
 * Whether `key` names an entry of `record`, narrowing it to that record's key type.
 *
 * The sprite tables, icon-alias maps and option maps in this package are closed object
 * literals whose keys are their own union, but a name arriving from props or from
 * `Object.keys` is a plain `string`. `key in record` alone does not narrow a `string`,
 * which is why those lookups used to assert the key type at each callsite. This states
 * the check once, and an unknown key stays a real, handled case.
 */
export function isKeyOf<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return key in record
}
