# Account Capability

The renderer's view of an account, and the closed set of authenticated
operations it may ask for by name. Product code asks this layer "who is signed
in" and "run this named operation"; it never builds an authenticated request and
never holds a credential.

The set of operations is `HostedOperationName` in `account-port.ts`;
`architecture/account-port.guard.test.ts` holds it equal to the app registry
and Electron main's route table. A generic `run(url, method, body)` here would
make Electron main a confused deputy, so the port cannot express one.
