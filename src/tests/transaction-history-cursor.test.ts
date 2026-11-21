import { describe, it, expect, vi } from 'vitest';
import {
  createTransactionHistoryPager,
  type RawTransactionPage,
} from '../dashboard/transaction-history.js';

function raw(id: string, createdAt = 1_700_000_000) {
  return {
    id,
    hash: `hash-${id}`,
    streamId: `stream-${id}`,
    kind: 'CREATE',
    status: 'CONFIRMED',
    amount: '100',
    asset: 'XLM',
    counterparty: 'GABC',
    createdAt,
  };
}

function pages(map: Record<string, RawTransactionPage>) {
  return vi.fn(async (cursor: string | undefined) => {
    const page = map[cursor ?? 'start'];
    if (!page) throw new Error(`unexpected cursor ${String(cursor)}`);
    return page;
  });
}

describe('createTransactionHistoryPager (#1084)', () => {
  it('walks the history page by page using the returned cursors', async () => {
    const fetchPage = pages({
      start: { items: [raw('a'), raw('b')], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      c1: { items: [raw('c')], pageInfo: { hasNextPage: false, endCursor: 'c2' } },
    });
    const pager = createTransactionHistoryPager(fetchPage);

    const first = await pager.fetchNextPage();
    expect(first.transactions.map((tx) => tx.id)).toEqual(['a', 'b']);
    expect(first).toMatchObject({ nextCursor: 'c1', hasNextPage: true });

    const second = await pager.fetchNextPage();
    expect(second.transactions.map((tx) => tx.id)).toEqual(['c']);
    expect(second).toMatchObject({ nextCursor: null, hasNextPage: false });
    expect(pager.hasNextPage).toBe(false);

    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'c1']);
  });

  it('does not fetch again once the last page has been returned', async () => {
    const fetchPage = pages({ start: { items: [raw('a')], pageInfo: { hasNextPage: false } } });
    const pager = createTransactionHistoryPager(fetchPage);

    await pager.fetchNextPage();
    const after = await pager.fetchNextPage();

    expect(after).toEqual({ transactions: [], nextCursor: null, hasNextPage: false });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('drops rows repeated across a page boundary', async () => {
    const fetchPage = pages({
      start: { items: [raw('a'), raw('b')], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      c1: { items: [raw('b'), raw('c')], pageInfo: { hasNextPage: false } },
    });
    const pager = createTransactionHistoryPager(fetchPage);

    await pager.fetchNextPage();
    const second = await pager.fetchNextPage();

    expect(second.transactions.map((tx) => tx.id)).toEqual(['c']);
  });

  it('accepts an explicit cursor and Relay edges', async () => {
    const fetchPage = pages({
      c9: {
        items: { edges: [{ node: raw('x') }] },
        pageInfo: { hasNextPage: true, endCursor: 'c10' },
      },
    });
    const pager = createTransactionHistoryPager(fetchPage);

    const page = await pager.fetchNextPage('c9');

    expect(fetchPage).toHaveBeenCalledWith('c9');
    expect(page.transactions.map((tx) => tx.id)).toEqual(['x']);
    expect(page.nextCursor).toBe('c10');
  });

  const loopCases: Array<[string, NonNullable<RawTransactionPage['pageInfo']>]> = [
    ['a missing cursor', { hasNextPage: true }],
    ['an empty cursor', { hasNextPage: true, endCursor: '' }],
    ['the same cursor again', { hasNextPage: true, endCursor: 'c1' }],
  ];

  it.each(loopCases)('stops instead of looping when the indexer returns %s', async (_label, pageInfo) => {
    const fetchPage = pages({ c1: { items: [raw('a')], pageInfo } });
    const pager = createTransactionHistoryPager(fetchPage);

    const page = await pager.fetchNextPage('c1');

    expect(page.hasNextPage).toBe(false);
    expect(pager.hasNextPage).toBe(false);
  });

  it('reset() starts again from the first page with no remembered rows', async () => {
    const fetchPage = pages({ start: { items: [raw('a')], pageInfo: { hasNextPage: false } } });
    const pager = createTransactionHistoryPager(fetchPage);

    await pager.fetchNextPage();
    pager.reset();
    const again = await pager.fetchNextPage();

    expect(again.transactions.map((tx) => tx.id)).toEqual(['a']);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
