import { describe, it, expect } from 'vitest';
import { sortProposals, type GovernorProposal } from '../hooks/useGovernorProposals.js';

describe('sortProposals (#997)', () => {
  const sampleProposals: GovernorProposal[] = [
    {
      id: '1',
      description: 'First Proposal',
      targetConfig: {},
      status: 'active',
      proposer: 'GAAAA',
      startTime: 1000,
      endTime: 2000,
      votesFor: 10n,
      votesAgainst: 5n,
    },
    {
      id: '2',
      description: 'Second Proposal',
      targetConfig: {},
      status: 'active',
      proposer: 'GBBBB',
      startTime: 3000,
      endTime: 4000,
      votesFor: 50n,
      votesAgainst: 20n,
    },
    {
      id: '3',
      description: 'Third Proposal',
      targetConfig: {},
      status: 'active',
      proposer: 'GCCCC',
      startTime: 2000,
      endTime: 3000,
      votesFor: 5n,
      votesAgainst: 1n,
    },
  ];

  it('preserves order when no sortBy is specified', () => {
    const sorted = sortProposals(sampleProposals);
    expect(sorted.map((p) => p.id)).toEqual(['1', '2', '3']);
  });

  it('sorts by votes descending (most contested first)', () => {
    const sorted = sortProposals(sampleProposals, 'votes', 'desc');
    // Proposal 2 has 70 total votes, Proposal 1 has 15 total votes, Proposal 3 has 6 total votes
    expect(sorted.map((p) => p.id)).toEqual(['2', '1', '3']);
  });

  it('sorts by votes ascending (least contested first)', () => {
    const sorted = sortProposals(sampleProposals, 'votes', 'asc');
    expect(sorted.map((p) => p.id)).toEqual(['3', '1', '2']);
  });

  it('sorts by date descending (newest first)', () => {
    const sorted = sortProposals(sampleProposals, 'date', 'desc');
    // Proposal 2: 3000, Proposal 3: 2000, Proposal 1: 1000
    expect(sorted.map((p) => p.id)).toEqual(['2', '3', '1']);
  });

  it('sorts by date ascending (oldest first)', () => {
    const sorted = sortProposals(sampleProposals, 'date', 'asc');
    expect(sorted.map((p) => p.id)).toEqual(['1', '3', '2']);
  });
});
