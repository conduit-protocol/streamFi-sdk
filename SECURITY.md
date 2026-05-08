# Security

## Reporting a Vulnerability

Do **not** open a public GitHub issue for security vulnerabilities in the SDK or the underlying contracts.

Report privately:

- **Email:** security@conduit.sh
- Include: description, reproduction steps, potential impact, and suggested fix if available.

We will acknowledge within 48 hours and provide a status update within one week.

## SDK-level Considerations

The SDK is a client library — it does not hold funds or execute privileged operations. However, several patterns deserve care:

### Private key handling

The SDK accepts a `Keypair` for signing transactions. Private keys must never be logged, stored in `localStorage`, or included in error messages.

```typescript
// Never do this
console.log('keypair:', config.keypair?.secret());

// The SDK itself never logs keypair data
```

### Transaction inspection before signing

The SDK simulates transactions before signing. If you are building on top of the SDK, always inspect the simulation result before presenting it to the user for signing. The assembled `Transaction` XDR should be decoded and shown to the user in human-readable form where possible.

### Fake contract IDs

If `factoryAddress` or `governorAddress` are passed in via untrusted input (e.g., a URL parameter), an attacker could point the SDK at a malicious contract that mimics the factory interface. Always source contract IDs from trusted configuration — environment variables set at build time, not user-supplied input.

### RPC endpoint trust

The configured RPC URL receives all transaction XDR before submission. Use a trusted RPC provider. For production, consider running your own Soroban RPC node.

## Known Limitations

- The SDK does not verify that a `factoryAddress` is a genuine Conduit deployment. There is no on-chain registry of official deployments.
- `withdrawableLocal()` is a client-side estimate and may diverge from the contract value if the stream was paused or topped up since the last `get()` call. Never use it for financial decisions — always confirm with `withdrawable()` (a chain simulation) before signing a withdrawal.

## Audit Status

The underlying `conduit-contracts` have not yet been audited. Do not use this SDK against Mainnet deployments with real funds until an audit is complete.
