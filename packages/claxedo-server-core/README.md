# @claxedo/server-core

Server-side primitives that the desktop-local product and the hosted product
both need, and that neither may own.

The split between `@claxedo/local-server` and `@claxedo/server` is a dependency
rule: neither product package may import the other. Measured against the real
import graph, the two share 62 modules — logging, data paths, the event bus,
HTTP error shape, database access, auth primitives, the credential engine,
session metadata. Duplicating those would put two implementations of each
responsibility in the repository. They live here instead, and both products
depend on this package.

This package holds no product capability and makes no composition decisions. If
something here has to ask "am I local or hosted?", it belongs in a product
package, not this one.
