/**
 * The two ways a capability is served when the integration implements none of
 * its operations. `code-host` is the third shape and is absent here: it names a
 * method, so its port is written out in full in its own file.
 */

/**
 * Served by handing the consumer a capability-scoped token, which it spends
 * against the provider itself. The integration contributes auth and nothing
 * else, so the port is a marker.
 *
 * `capability` is the only member, and it is the one that does work: it makes
 * ports non-interchangeable, so `actions: { docs: workSourcePort }` is a
 * compile error rather than a silently mislabelled grant, and it gives the
 * registry a value to re-check for a host that registers from JavaScript.
 */
export type TokenPort<Capability extends string> = { readonly capability: Capability }

/**
 * Served by an external broker whose operation schemas the kit neither owns nor
 * validates. Also a marker, and necessarily so: a brokered integration has no
 * methods to count, so a registry deriving capabilities from method names alone
 * would resolve every brokered integration to nothing at all.
 */
export type BrokeredPort<Capability extends string> = { readonly capability: Capability }
