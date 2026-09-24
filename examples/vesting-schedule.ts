/**
 * Example: Create a vesting schedule with a cliff + linear vesting.
 *
 * Demonstrates the real-world pattern of employees/contractors earning tokens
 * over time: locked in full for a cliff period, then linearly available after.
 *
 * Patterns:
 * - Cliff: recipient gets nothing until cliff_end_time; then a lump sum is
 *   immediately available.
 * - Linear vesting: after the cliff, tokens flow linearly at a constant rate
 *   from cliff_end_time to vesting_end_time.
 *
 * Implementation: A stream is created at time `now`, but with start_time set to
 * cliff_end_time. The stream ends at vesting_end_time. Until cliff_end_time,
 * nothing is withdrawable (stream hasn't started). After cliff_end_time, the
 * tokens accrued since cliff_end_time are withdrawable, creating the linear
 * vesting effect.
 *
 * Run with:
 *   STELLAR_SECRET=S... FACTORY_ADDRESS=C... npx ts-node examples/vesting-schedule.ts
 */

import { ConduitClient, MIN_STREAM_DURATION_SECONDS, toStroops, fromStroops } from '../src/index.js';
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

interface VestingParams {
  recipient: string;
  token: string;
  totalAmount: string; // e.g., "1000" XLM
  cliffDays: number; // e.g., 30 days until first tokens become available
  vestingDays: number; // e.g., 365 days total vesting period
  clawbackEnabled?: boolean;
}

function createVestingSchedule(params: VestingParams) {
  const now = Math.floor(Date.now() / 1000);

  const cliffEndTime = now + params.cliffDays * 86400;
  const vestingEndTime = now + params.vestingDays * 86400;
  const vestingDurationSeconds = vestingEndTime - cliffEndTime;

  // Validate vesting duration
  if (vestingDurationSeconds < MIN_STREAM_DURATION_SECONDS) {
    throw new Error(
      `Vesting duration must be at least ${MIN_STREAM_DURATION_SECONDS} seconds ` +
        `(~${Math.ceil(MIN_STREAM_DURATION_SECONDS / 3600)} hours). ` +
        `Calculated: ${vestingDurationSeconds} seconds.`
    );
  }

  return {
    recipient: params.recipient,
    token: params.token,
    depositAmount: params.totalAmount,
    durationSeconds: vestingDurationSeconds,
    startTime: cliffEndTime,
    endTime: vestingEndTime,
    clawbackEnabled: params.clawbackEnabled ?? false,
    scheduleInfo: {
      cliffEndTime,
      vestingEndTime,
      vestingDurationSeconds,
      cliffDays: params.cliffDays,
      vestingDays: params.vestingDays,
    },
  };
}

async function main(): Promise<void> {
  const employee = 'GABC1234EMPLOYEEADDRESS00000000000000000000000000000000';

  // Create a vesting schedule:
  // - 30 day cliff: nothing is withdrawable for 30 days
  // - 365 day total vesting: after cliff, 335 more days of linear vesting
  // - Total: 1000 XLM vests over 365 days, with 30-day cliff
  const vestingParams: VestingParams = {
    recipient: employee,
    token: 'native', // XLM
    totalAmount: '1000',
    cliffDays: 30,
    vestingDays: 365,
    clawbackEnabled: true, // Employer can reclaim unvested tokens
  };

  console.log('Creating vesting schedule:');
  console.log(`  Recipient:        ${vestingParams.recipient}`);
  console.log(`  Total amount:     ${vestingParams.totalAmount} XLM`);
  console.log(`  Cliff period:     ${vestingParams.cliffDays} days`);
  console.log(`  Vesting period:   ${vestingParams.vestingDays} days`);

  try {
    const createParams = createVestingSchedule(vestingParams);

    console.log(`\n  Stream details:`);
    console.log(`    Start time:     ${new Date(createParams.startTime * 1000).toISOString()}`);
    console.log(`    End time:       ${new Date(createParams.endTime * 1000).toISOString()}`);
    console.log(`    Duration:       ${createParams.durationSeconds} seconds`);
    console.log(`    Clawback:       ${createParams.clawbackEnabled}`);

    const result = await client.streams.create(createParams);

    console.log(`\n✅ Vesting stream created!`);
    console.log(`  Stream ID:      ${result.streamId}`);
    console.log(`  Stream address: ${result.streamAddress}`);
    console.log(`  Transaction:    ${result.txHash}`);

    // Demonstrate checking withdrawable amount at different times
    const schedule = createParams.scheduleInfo;

    console.log(`\n--- Withdrawal availability over time ---`);

    // At creation time (cliff hasn't ended yet)
    console.log(`\n1. Right now (cliff active):`);
    const withdrawableNow = await client.streams.withdrawable(result.streamId);
    console.log(
      `   Withdrawable: ${fromStroops(withdrawableNow)} XLM ` +
        `(should be 0, cliff ends in ${schedule.cliffDays} days)`
    );

    // After cliff (simulated)
    const secondsUntilCliffEnd = schedule.cliffEndTime - Math.floor(Date.now() / 1000);
    console.log(
      `\n2. After cliff (in ~${Math.ceil(secondsUntilCliffEnd / 3600)} hours):`
    );
    console.log(
      `   Withdrawable: ${vestingParams.totalAmount} XLM ` +
        `(all accrued since cliff start)`
    );

    // Midway through vesting
    const midVestingTime = Math.floor(
      (schedule.cliffEndTime + schedule.vestingEndTime) / 2
    );
    const daysAtMidpoint = Math.ceil(
      (midVestingTime - schedule.cliffEndTime) / 86400
    );
    const halfVestingAmount = (parseInt(vestingParams.totalAmount) / 2).toFixed(2);
    console.log(
      `\n3. Midway through vesting (in ~${daysAtMidpoint} days):`
    );
    console.log(
      `   Withdrawable: ~${halfVestingAmount} XLM ` +
        `(linear vesting, halfway through schedule)`
    );

    // At vesting end
    console.log(
      `\n4. At vesting end (in ${schedule.vestingDays} days):`
    );
    console.log(
      `   Withdrawable: ${vestingParams.totalAmount} XLM ` +
        `(full amount accrued)`
    );

    console.log(`\n--- Notes ---`);
    console.log(
      `• Cliff period: from now until ${new Date(schedule.cliffEndTime * 1000).toISOString()}`
    );
    console.log(
      `• Linear vesting: from cliff end until ${new Date(schedule.vestingEndTime * 1000).toISOString()}`
    );
    console.log(
      `• Clawback enabled: employer can recover unvested tokens before vesting end`
    );
  } catch (err) {
    console.error('❌ Error creating vesting stream:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
