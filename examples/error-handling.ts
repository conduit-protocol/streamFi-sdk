/**
 * Example: Handle every typed SDK error when creating, withdrawing from, and
 * managing streams.
 *
 * The SDK throws a rich hierarchy of error types, each carrying structured
 * information to help UI code display user-friendly error messages and detect
 * recoverable conditions.
 *
 * Run with:
 *   STELLAR_SECRET=S... FACTORY_ADDRESS=C... npx ts-node examples/error-handling.ts
 */

import {
  ConduitClient,
  ConduitError,
  AmountExceedsWithdrawableError,
  UnauthorizedStreamActionError,
  InvalidStreamStateError,
  UnsupportedChainError,
  InsufficientBalanceError,
  MIN_STREAM_DURATION_SECONDS,
} from '../src/index.js';
import { Keypair } from '@stellar/stellar-sdk';

const secret = process.env['STELLAR_SECRET'];
const factoryAddress = process.env['FACTORY_ADDRESS'];

if (!secret || !factoryAddress) {
  console.error('Set STELLAR_SECRET and FACTORY_ADDRESS environment variables.');
  process.exit(1);
}

const keypair = Keypair.fromSecret(secret);
const client = new ConduitClient({
  network: 'testnet',
  keypair,
  factoryAddress,
});

function handleError(err: unknown): void {
  // 1. Unsupported network errors are thrown synchronously at client construction.
  if (err instanceof UnsupportedChainError) {
    console.error(
      `❌ Network error: ${err.message}`,
      `   Supported networks: ${err.supportedNetworks.join(', ')}`
    );
    return;
  }

  // 2. Insufficient balance errors when creating streams or paying fees.
  if (err instanceof InsufficientBalanceError) {
    console.error(
      `❌ Balance error: ${err.message}`,
      `   Available:  ${err.available} stroops`,
      `   Required:   ${err.required} stroops`
    );
    return;
  }

  // 3. Amount exceeds withdrawable: the requested amount is larger than available.
  if (err instanceof AmountExceedsWithdrawableError) {
    console.error(
      `❌ Withdrawal error: ${err.message}`,
      `   You can withdraw up to: ${err.available} stroops`
    );
    return;
  }

  // 4. Unauthorized stream action: caller lacks permission (e.g., not sender/recipient).
  if (err instanceof UnauthorizedStreamActionError) {
    console.error(
      `❌ Permission error: ${err.message}`,
      `   Operation:  ${err.operation}`,
      `   Caller:     ${err.caller}`
    );
    return;
  }

  // 5. Invalid stream state: operation cannot be performed in current state.
  //    E.g., cannot cancel an already-ended stream.
  if (err instanceof InvalidStreamStateError) {
    console.error(
      `❌ State error: ${err.message}`,
      `   Stream:     ${err.streamId}`,
      `   State:      ${err.currentState}`,
      `   Operation:  ${err.operation}`
    );
    return;
  }

  // 6. Generic ConduitError: contract error from Soroban with a numeric code.
  //    Use ConduitError.isKnown to check if the SDK recognises the code.
  if (err instanceof ConduitError) {
    if (err.isKnown) {
      console.error(
        `❌ Contract error: ${err.message}`,
        `   Contract: ${err.contract}`,
        `   Code:     ${err.code} (known)`
      );
    } else {
      console.error(
        `❌ Unknown contract error: ${err.message}`,
        `   Contract: ${err.contract}`,
        `   Code:     ${err.code} (unknown — SDK does not recognize this error code)`
      );
    }
    return;
  }

  // 7. All other errors: network failures, timeouts, or non-SDK errors.
  if (err instanceof Error) {
    console.error(`❌ Unexpected error: ${err.message}`);
    return;
  }

  console.error(`❌ Unknown error:`, err);
}

async function main(): Promise<void> {
  const recipient = 'GABC1234RECIPIENTADDRESSEXAMPLE000000000000000000000000';

  // Demonstrate various error scenarios.

  console.log('--- Scenario 1: Duration too short ---');
  try {
    await client.streams.create({
      recipient,
      token: 'native',
      depositAmount: '100',
      durationSeconds: 100, // Too short (MIN_STREAM_DURATION_SECONDS = 3600)
    });
  } catch (err) {
    handleError(err);
  }

  console.log('\n--- Scenario 2: Insufficient deposit ---');
  try {
    await client.streams.create({
      recipient,
      token: 'native',
      depositAmount: '0.0001', // Too small
      durationSeconds: MIN_STREAM_DURATION_SECONDS,
    });
  } catch (err) {
    handleError(err);
  }

  console.log('\n--- Scenario 3: Invalid time range ---');
  try {
    const now = Math.floor(Date.now() / 1000);
    await client.streams.create({
      recipient,
      token: 'native',
      depositAmount: '100',
      durationSeconds: MIN_STREAM_DURATION_SECONDS,
      startTime: now + 1000,
      endTime: now + 100, // End before start
    });
  } catch (err) {
    handleError(err);
  }

  console.log('\n--- Scenario 4: Withdraw from non-existent stream ---');
  try {
    // Use an invalid stream ID (high entropy random value).
    const fakeStreamId = BigInt('999999999999999999');
    await client.streams.withdraw(fakeStreamId, 1000n);
  } catch (err) {
    handleError(err);
  }

  console.log('\n--- Scenario 5: Withdraw more than available ---');
  try {
    // Create a stream first (this may fail if balance is low).
    const result = await client.streams.create({
      recipient,
      token: 'native',
      depositAmount: '10',
      durationSeconds: MIN_STREAM_DURATION_SECONDS,
    });

    // Try to withdraw more than is currently available.
    await client.streams.withdraw(result.streamId, BigInt('999999999999'));
  } catch (err) {
    handleError(err);
  }

  console.log('\n--- Scenario 6: Cancel stream not owned by caller ---');
  try {
    // Create a stream with a different recipient.
    const otherRecipient = 'GBRPYHIL2CI3WHZDTOOQFC6EB4LGCU5XVJF5XPBWWFMQ6Lready000000';
    const result = await client.streams.create({
      recipient: otherRecipient,
      token: 'native',
      depositAmount: '10',
      durationSeconds: MIN_STREAM_DURATION_SECONDS,
    });

    // Try to cancel as a different account (would fail with UnauthorizedStreamActionError
    // if we had a different keypair, but in this demo we're using the same account).
    // This demonstrates the pattern for catching the error.
    await client.streams.cancel(result.streamId);
  } catch (err) {
    handleError(err);
  }

  console.log('\nDemo complete. Check the console for error examples.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
