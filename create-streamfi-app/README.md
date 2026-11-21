# create-streamfi-app

Scaffold a Next.js app ready to use StreamFi on Stellar testnet.

```bash
npx create-streamfi-app my-streamfi-app
```

The command copies a bundled, StreamFi-wired Next.js template (the app that lists, creates, and withdraws from
streams via `@conduit-protocol/sdk` — see [`examples/nextjs-app`](../examples/nextjs-app)), installs its
dependencies, then creates `.env.local` with `NEXT_PUBLIC_NETWORK=testnet` plus blank placeholders for
`FACTORY_ADDRESS`, `STELLAR_SECRET`, and `NEXT_PUBLIC_ADDRESS` for you to fill in.

To use a different starter instead of the bundled template:

```bash
npx create-streamfi-app my-streamfi-app --template https://github.com/your-org/your-template.git
```

Use `--skip-install` to clone and configure a project without running npm installs.
