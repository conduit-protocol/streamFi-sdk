export type ConnectionHealthLevel = "healthy" | "degraded" | "disconnected";

export interface EndpointHealth {
  url: string;
  connected: boolean;
  latencyMs: number | null;
  packetLossRate: number;
  samples: number;
  successes: number;
  failures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  updatedAt: number | null;
  status: ConnectionHealthLevel;
}

export interface RelayerHealth {
  connected: boolean;
  latencyMs: number | null;
  packetLossRate: number;
  samples: number;
  successes: number;
  failures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  updatedAt: number | null;
  status: ConnectionHealthLevel;
}

export interface ConnectionHealthStatus {
  connected: boolean;
  status: ConnectionHealthLevel;
  latencyMs: number | null;
  packetLossRate: number;
  activeRpcUrl: string;
  rpc: EndpointHealth;
  endpoints: EndpointHealth[];
  relayer: RelayerHealth;
  updatedAt: number | null;
}

interface HealthSample {
  at: number;
  durationMs: number;
  ok: boolean;
}

const HEALTH_WINDOW_MS = 60_000;
const MAX_SAMPLES = 200;
const RELAYER_SCOPE = "relayer";
const samplesByScope = new Map<string, HealthSample[]>();

function scopeKey(scope: string, kind: "rpc" | "relayer"): string {
  return kind === "relayer" ? RELAYER_SCOPE : `rpc:${scope}`;
}

export function recordConnectionResult(
  scope: string,
  ok: boolean,
  durationMs: number,
  kind: "rpc" | "relayer" = "rpc",
): void {
  const key = scopeKey(scope, kind);
  const now = Date.now();
  const existing = samplesByScope.get(key) ?? [];
  const recent = existing.filter((sample) => now - sample.at <= HEALTH_WINDOW_MS);
  recent.push({ at: now, durationMs: Math.max(0, durationMs), ok });
  samplesByScope.set(key, recent.slice(-MAX_SAMPLES));
}

function healthLevel(connected: boolean, packetLossRate: number): ConnectionHealthLevel {
  if (!connected) return "disconnected";
  if (packetLossRate >= 0.5) return "degraded";
  return "healthy";
}

function snapshot(key: string, url: string): EndpointHealth {
  const samples = samplesByScope.get(key) ?? [];
  const now = Date.now();
  const recent = samples.filter((sample) => now - sample.at <= HEALTH_WINDOW_MS);
  const successes = recent.filter((sample) => sample.ok);
  const failures = recent.length - successes.length;
  const last = recent[recent.length - 1];
  const lastSuccess = successes[successes.length - 1];
  const lastFailure = recent.filter((sample) => !sample.ok).at(-1);
  const connected = recent.length > 0 && last?.ok === true;
  const latencyMs =
    successes.length === 0
      ? null
      : Math.round(
          (successes.reduce((sum, sample) => sum + sample.durationMs, 0) /
            successes.length) *
            100,
        ) / 100;

  return {
    url,
    connected,
    latencyMs,
    packetLossRate: recent.length === 0 ? 0 : failures / recent.length,
    samples: recent.length,
    successes: successes.length,
    failures,
    lastSuccessAt: lastSuccess?.at ?? null,
    lastFailureAt: lastFailure?.at ?? null,
    updatedAt: last?.at ?? null,
    status: healthLevel(connected, failures / Math.max(1, recent.length)),
  };
}

export function getEndpointHealth(url: string): EndpointHealth {
  return snapshot(scopeKey(url, "rpc"), url);
}

export function getRelayerHealth(): RelayerHealth {
  const { url: _url, ...health } = snapshot(RELAYER_SCOPE, RELAYER_SCOPE);
  return health;
}

export function resetConnectionHealth(scope?: string): void {
  if (scope === undefined) {
    samplesByScope.clear();
    return;
  }
  if (scope === RELAYER_SCOPE) {
    samplesByScope.delete(RELAYER_SCOPE);
  } else {
    samplesByScope.delete(scopeKey(scope, "rpc"));
  }
}
