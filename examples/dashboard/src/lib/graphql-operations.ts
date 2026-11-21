import { gql } from '@apollo/client';

export const GET_DASHBOARD_STATS = gql`
  query GetDashboardStats($walletAddress: String!) {
    dashboardStats(walletAddress: $walletAddress) {
      activeStreams
      totalVolume
      pendingStreams
    }
  }
`;

export const GET_RECENT_STREAMS = gql`
  query GetRecentStreams($walletAddress: String!, $limit: Int) {
    streams(walletAddress: $walletAddress, limit: $limit, orderBy: { field: CREATED_AT, direction: DESC }) {
      id
      streamId
      recipient
      ratePerSecond
      status
      createdAt
    }
  }
`;

export const GET_TRANSACTION_HISTORY = gql`
  query GetTransactionHistory($walletAddress: String!, $limit: Int) {
    transactions(walletAddress: $walletAddress, limit: $limit, orderBy: { field: TIMESTAMP, direction: DESC }) {
      id
      hash
      streamId
      kind
      direction
      status
      amount
      asset
      counterparty
      timestamp
    }
  }
`;

export const CREATE_STREAM = gql`
  mutation CreateStream($input: CreateStreamInput!) {
    createStream(input: $input) {
      id
      streamId
      recipient
      ratePerSecond
      status
    }
  }
`;

export const WITHDRAW_STREAM = gql`
  mutation WithdrawStream($streamId: ID!) {
    withdrawStream(streamId: $streamId) {
      id
      withdrawn
      status
    }
  }
`;

export const PAUSE_STREAM = gql`
  mutation PauseStream($streamId: ID!) {
    pauseStream(streamId: $streamId) {
      id
      status
      paused
    }
  }
`;

export const RESUME_STREAM = gql`
  mutation ResumeStream($streamId: ID!) {
    resumeStream(streamId: $streamId) {
      id
      status
      paused
    }
  }
`;

export const CANCEL_STREAM = gql`
  mutation CancelStream($streamId: ID!) {
    cancelStream(streamId: $streamId) {
      id
      status
      cancelled
    }
  }
`;

export const GET_TOKENS = gql`
  query GetTokens {
    tokens {
      id
      symbol
      name
      logoUrl
    }
  }
`;
