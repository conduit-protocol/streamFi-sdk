# Next.js Example

A minimal Next.js (App Router) example that uses `@conduit-protocol/sdk` to list active streams and create new ones.

## Prerequisites

- Node.js 18+
- A Stellar testnet secret key (for creating streams)
- A Stellar address to query streams for

## Setup

```bash
# From the repo root
npm install

# Build the SDK
npm run build

# Go to the example
cd examples/nextjs-app

# Copy and fill in the environment variables
cp .env.example .env.local
```

Edit `.env.local`:

| Variable | Description |
|----------|-------------|
| `STELLAR_SECRET` | Secret key for signing transactions (optional for read-only). Deliberately **not** `NEXT_PUBLIC_`-prefixed — it's only read inside Server Actions (`lib/streams.ts`), never bundled to the client. Never add the `NEXT_PUBLIC_` prefix to this variable. |
| `NEXT_PUBLIC_NETWORK` | `testnet` (default), `mainnet`, or `local` |
| `NEXT_PUBLIC_ADDRESS` | Default address to query streams for |

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Enter a Stellar address and click **Fetch Streams** to view active streams. Click **+ New Stream** to open the creation form.
