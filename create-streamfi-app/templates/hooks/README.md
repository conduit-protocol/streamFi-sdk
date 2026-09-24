# StreamFi App

A Next.js (App Router) app scaffolded by `create-streamfi-app`, wired up to list, create, and withdraw from
[StreamFi](https://github.com/conduit-protocol/streamFi-sdk) streams via `@conduit-protocol/sdk`.

## Setup

`create-streamfi-app` already wrote `.env.local` with `NEXT_PUBLIC_NETWORK=testnet`. Fill in the rest:

| Variable | Description |
|----------|-------------|
| `STELLAR_SECRET` | Secret key for signing transactions (optional for read-only use). Deliberately **not** `NEXT_PUBLIC_`-prefixed — it's only read inside Server Actions (`lib/streams.ts`), never bundled to the client. Never add the `NEXT_PUBLIC_` prefix to this variable. |
| `FACTORY_ADDRESS` | The deployed DripFactory contract ID for your chosen network. Required for `list()`/`streamCount()`/`streamAddress()` queries. |
| `NEXT_PUBLIC_NETWORK` | `testnet` (default), `mainnet`, or `local` |
| `NEXT_PUBLIC_ADDRESS` | Default Stellar address to query streams for |

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Enter a Stellar address and click **Fetch Streams** to view
active streams. Click **+ New Stream** to open the creation form.
