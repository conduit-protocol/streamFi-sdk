import { describe, it, expect } from 'vitest';
import { ProposalState, parseProposalState, formatProposalState } from '../governor.js';

describe('ProposalState helpers (#860)', () => {
  it('maps contract integers to labels', () => {
    expect(formatProposalState(0)).toBe('Pending');
    expect(formatProposalState(1)).toBe('Active');
    expect(formatProposalState(2)).toBe('Defeated');
    expect(formatProposalState(3)).toBe('Succeeded');
  });

  it('renders unknown values as Unknown', () => {
    expect(formatProposalState(9)).toBe('Unknown');
    expect(formatProposalState(-1)).toBe('Unknown');
    expect(formatProposalState(1.5)).toBe('Unknown');
    expect(formatProposalState(NaN)).toBe('Unknown');
  });

  it('parses numbers, bigints and numeric strings', () => {
    expect(parseProposalState(1)).toBe(ProposalState.Active);
    expect(parseProposalState(3n)).toBe(ProposalState.Succeeded);
    expect(parseProposalState('2')).toBe(ProposalState.Defeated);
    expect(parseProposalState('')).toBeUndefined();
    expect(parseProposalState(null)).toBeUndefined();
    expect(parseProposalState('abc')).toBeUndefined();
  });
});
