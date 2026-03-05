export type CheckMode = "upload" | "repo";
export type CheckOrigin = "upload" | "repo";

export interface CheckResult {
  id: string;
  source: string;
  origin: CheckOrigin;
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
  mode: CheckMode;
  source_label: string;
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
  source: string;
  origin: CheckOrigin;
  path: string;
  status: string;
  provider: string;
}

export interface ArchiveInput {
  name: string;
  arrayBuffer: ArrayBuffer;
}

export interface RepoConfig {
  repoUrl: string;
  githubToken: string;
  branch: string;
  authSubdir: string;
}

export interface RepoImportResult {
  imported_paths: string[];
  skipped_paths: string[];
}

export interface RepoDeleteResult {
  deleted_paths: string[];
  failed_paths: string[];
}

export type ProviderScope = "all" | "codex";
