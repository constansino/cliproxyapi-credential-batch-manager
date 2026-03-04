export interface CheckResult {
  file: string;
  path: string;
  provider: string;
  email: string;
  status: string;
  http_status: number | null;
  reason: string;
  detail: string;
  expired_field: string;
  access_token_exp_utc: string;
  checked_at_utc: string;
  elapsed_ms: number;
}

export interface CheckSummary {
  by_status: Record<string, number>;
  by_provider: Record<string, number>;
  by_provider_status: Record<string, Record<string, number>>;
}

export interface CheckReport {
  checked_at_utc: string;
  duration_seconds: number;
  mode: "upload";
  codex_model: string;
  codex_usage_limit_only: boolean;
  total: number;
  summary: CheckSummary;
  results: CheckResult[];
}

export interface CheckOptions {
  codexModel: string;
  codexUsageLimitOnly: boolean;
  timeoutSeconds: number;
  workers: number;
}

export interface CleanupResultRef {
  path: string;
  status: string;
  provider: string;
}

export type ProviderScope = "all" | "codex";
