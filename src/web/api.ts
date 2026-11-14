import type {
  Candle,
  DashboardStats,
  EventView,
  PublicSettings,
  Rule,
  RuleDraft,
  RuleEvaluation,
  RuleView,
  TrialResult,
  TriggerMode,
  AppStatus,
  DiagnosticInfo,
} from '../shared/types';

export interface ValidationIssue {
  code: string;
  message: string;
  conditionId?: string;
}

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const record = body as { error?: string; details?: unknown } | null;
    throw new ApiError(record?.error || `请求失败（HTTP ${response.status}）`, response.status, record?.details);
  }
  return body as T;
}

export interface DashboardResponse {
  status: AppStatus;
  settings: PublicSettings;
  stats: DashboardStats;
  rules: RuleView[];
  recentEvents: EventView[];
  marketPairs: {
    instId: string;
    timeframe: string;
    state: string;
    latestClosedOpen: number | null;
    latestClosedAt: number | null;
    lastReceivedAt: number | null;
    bars: number;
  }[];
}

export interface PreviewResult {
  summary: string;
  warnings: ValidationIssue[];
  results: {
    symbol: string;
    ok: boolean;
    evaluation?: RuleEvaluation;
    reason?: string;
    message?: string;
  }[];
}

export interface RulePayload extends RuleDraft {
  enabled?: boolean;
}

export interface EventListResponse {
  events: EventView[];
  total: number;
}

export interface InstrumentInfo {
  instId: string;
  instType: string;
  state?: string;
  baseCcy?: string;
  quoteCcy?: string;
  settleCcy?: string;
  tickSz?: string;
  lotSz?: string;
  ctVal?: string;
  ctValCcy?: string;
}

export interface CandlePageResponse {
  instId: string;
  timeframe: string;
  candles: Candle[];
  page: {
    hasMore: boolean;
    oldest: number | null;
    newest: number | null;
  };
}

export interface HealthResponse {
  status: string;
  version: string;
  startedAt: number;
  now: number;
  exchangeNow: number;
  wsState: string;
  wsConnected: boolean;
  discordConfigured: boolean;
  notificationChannel: 'discord' | 'pushplus';
  notificationsConfigured: boolean;
}

export const api = {
  dashboard: () => request<DashboardResponse>('/api/dashboard'),
  health: () => request<HealthResponse>('/api/health'),
  rules: () => request<{ rules: RuleView[] }>('/api/rules'),
  rule: (id: string) => request<{ rule: RuleView }>(`/api/rules/${id}`),
  createRule: (payload: RulePayload) =>
    request<{ rule: RuleView; warnings: ValidationIssue[] }>('/api/rules', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateRule: (id: string, payload: RulePayload) =>
    request<{ rule: RuleView; warnings: ValidationIssue[] }>(`/api/rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  setRuleEnabled: (id: string, enabled: boolean) =>
    request<{ rule: RuleView }>(`/api/rules/${id}/enabled`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  deleteRule: (id: string) => request<{ ok: true }>(`/api/rules/${id}`, { method: 'DELETE' }),
  duplicateRule: (id: string) =>
    request<{ rule: RuleView }>(`/api/rules/${id}/duplicate`, { method: 'POST' }),
  validateRule: (payload: RulePayload) =>
    request<{ ok: true; summary: string; warnings: ValidationIssue[] }>('/api/rules/validate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  previewRule: (payload: RulePayload) =>
    request<PreviewResult>('/api/rules/preview', { method: 'POST', body: JSON.stringify(payload) }),
  trialRule: (payload: RulePayload & { symbol: string; windowDays: number }) =>
    request<TrialResult>('/api/rules/trial', { method: 'POST', body: JSON.stringify(payload) }),
  events: (params: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') qs.set(key, String(value));
    });
    return request<EventListResponse>(`/api/events${qs.size ? `?${qs.toString()}` : ''}`);
  },
  event: (id: string) => request<{ event: EventView }>(`/api/events/${id}`),
  retryEvent: (id: string) => request<{ event: EventView }>(`/api/events/${id}/retry`, { method: 'POST' }),
  instruments: (query = '') =>
    request<{ instruments: InstrumentInfo[] }>(`/api/instruments?query=${encodeURIComponent(query)}`),
  candles: (instId: string, timeframe: string, limit = 200) =>
    request<{ instId: string; timeframe: string; candles: Candle[] }>(
      `/api/candles?instId=${encodeURIComponent(instId)}&timeframe=${encodeURIComponent(timeframe)}&limit=${limit}`,
    ),
  candlesPage: (params: { instId: string; timeframe: string; limit?: number; before?: number }) => {
    const qs = new URLSearchParams({
      instId: params.instId,
      timeframe: params.timeframe,
      limit: String(params.limit ?? 500),
    });
    if (params.before !== undefined) qs.set('before', String(params.before));
    return request<CandlePageResponse>(`/api/candles?${qs.toString()}`);
  },
  candlesStreamUrl: (instId: string, timeframe: string) => {
    const qs = new URLSearchParams({ instId, timeframe });
    return `/api/candles/stream?${qs.toString()}`;
  },
  settings: () => request<{ settings: PublicSettings }>('/api/settings'),
  saveSettings: (payload: Record<string, unknown>) =>
    request<{ settings: PublicSettings }>('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  testOkx: (proxyUrl?: string) =>
    request<{ ok: true; latencyMs: number; serverNow: number }>('/api/settings/test-okx', {
      method: 'POST',
      body: JSON.stringify(proxyUrl !== undefined ? { proxyUrl } : {}),
    }),
  testPushplus: (pushplusToken?: string, pushplusTopic?: string) =>
    request<{ ok: true; httpStatus: number; messageId: string | null }>('/api/settings/test-pushplus', {
      method: 'POST',
      body: JSON.stringify({
        ...(pushplusToken ? { pushplusToken } : {}),
        ...(pushplusTopic ? { pushplusTopic } : {}),
      }),
    }),
  testDiscord: (webhookUrl?: string) =>
    request<{ ok: true; httpStatus: number; messageId: string | null }>('/api/settings/test-discord', {
      method: 'POST',
      body: JSON.stringify(webhookUrl ? { webhookUrl } : {}),
    }),
  diagnostics: () => request<DiagnosticInfo>('/api/diagnostics'),
  status: () => request<AppStatus>('/api/status'),
};

export type { Rule, RuleView, RuleDraft, TriggerMode, EventView, TrialResult };
