# React Dashboard Example

A minimal React dashboard demonstrating the `@streamfi/react` hooks for managing Conduit streams.

## Features

- 📋 View all streams for your account
- ➕ Create new streams with a form
- 💰 Withdraw from streams
- 🔄 Real-time stream status tracking
- ⚡ Built with React 18 + TypeScript + Vite

## Hooks Demonstrated

- `useStreamFiClient` — Access the Conduit SDK client
- `useStreamList` — Fetch and display all streams
- `useStream` — Get details about a single stream
- `useCreateStream` — Create new streams
- `useWithdrawStream` — Withdraw from streams

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env.local` file:

```bash
cp .env.example .env.local
```

Edit `.env.local` and set:

- `VITE_STELLAR_SECRET` — Your Stellar secret key (starts with `S`)
  - Generate: `node -e "console.log(require('@stellar/stellar-sdk').Keypair.random().secret())"`
  - **⚠️ Keep this secret! Never commit to version control.**
- `VITE_FACTORY_ADDRESS` — DripFactory contract address (starts with `C`)
  - Find this in the [protocol documentation](https://github.com/conduit-protocol/protocol)

### 3. Fund your testnet account

```bash
# Get your public key
node -e "console.log(require('@stellar/stellar-sdk').Keypair.fromSecret('S...').publicKey())"

# Fund via Friendbot
curl "https://friendbot.stellar.org?addr=G..."
```

### 4. Run the dashboard

```bash
npm run dev
```

Opens at `http://localhost:5173`

## Project Structure

```
├── src/
│   ├── main.tsx              # App entry point
│   ├── App.tsx               # Root component + StreamFiProvider
│   ├── App.css               # Main layout styles
│   ├── index.css             # Global styles
│   └── components/
│       ├── StreamList.tsx    # useStreamList hook demo
│       ├── StreamCard.tsx    # useStream + useWithdrawStream hooks
│       ├── CreateStreamForm.tsx  # useCreateStream hook demo
│       └── *.css             # Component styles
├── index.html                # HTML entry point
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Key Concepts

### StreamFiProvider

Wraps your app and provides SDK context to all child components:

```tsx
<StreamFiProvider
  network="testnet"
  walletAdapter={walletAdapter}
  factoryAddress={factoryAddress}
>
  {children}
</StreamFiProvider>
```

### Using Hooks

All hooks must be used inside a `<StreamFiProvider>`:

```tsx
function MyComponent() {
  const { streams, loading, error } = useStreamList();
  
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  
  return <div>{streams.length} streams</div>;
}
```

### Error Handling

Catch SDK errors using the `error` property from hooks:

```tsx
const { createStream, error } = useCreateStream();

if (error instanceof ConduitError) {
  // Handle typed SDK errors
}
```

## Common Tasks

### Create a stream

```tsx
const { createStream, loading } = useCreateStream();

await createStream({
  recipient: 'G...',
  token: 'native',
  depositAmount: '100',
  durationSeconds: 86400, // 1 day
  clawbackEnabled: true,
});
```

### Withdraw from a stream

```tsx
const { withdraw, loading } = useWithdrawStream();

await withdraw({
  streamId: BigInt('123'),
  amount: BigInt('1000000'), // stroops
});
```

### List streams with polling

```tsx
const { streams, loading, refetch } = useStreamList();

// Refetch after an action
await createStream(...);
await refetch();
```

## Troubleshooting

### "Configuration Error" message

Check that `.env.local` has both `VITE_STELLAR_SECRET` and `VITE_FACTORY_ADDRESS` set correctly.

### "Not Connected" errors

Ensure your account is funded on testnet:

```bash
curl "https://friendbot.stellar.org?addr=YOUR_G_ADDRESS"
```

### Build or type errors

Run TypeScript check:

```bash
npx tsc --noEmit
```

## Resources

- [Conduit SDK Documentation](https://github.com/conduit-protocol/conduit-sdk)
- [React Hooks Documentation](../../packages/react/README.md)
- [Stellar Documentation](https://developers.stellar.org)

## License

MIT
