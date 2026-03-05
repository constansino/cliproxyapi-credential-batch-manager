import JSZip from "jszip";
import {
  ArchiveInput,
  CheckOptions,
  CheckOrigin,
  CheckReport,
  CheckResult,
  CheckSummary,
  CleanupResultRef,
  ProviderScope,
  RepoConfig,
  RepoDeleteResult,
  RepoImportResult
} from "@/lib/types";

interface HttpResponse {
  statusCode: number;
  responseText: string;
}

interface CredentialInput {
  origin: CheckOrigin;
  source: string;
  path: string;
  rawText: string;
}

interface RepoFileEntry {
  path: string;
  name: string;
  sha: string;
}

interface GitTreeEntry {
  path: string;
  type: "tree" | "blob";
  sha: string;
}

interface NormalizedRepoConfig {
  repoUrl: string;
  githubToken: string;
  branch: string;
  authSubdir: string;
  owner: string;
  repo: string;
}

type JsonValue = Record<string, unknown>;

const DEFAULT_TIMEOUT_SECONDS = 35;
const DEFAULT_WORKERS = 200;
const MAX_DETAIL_BYTES = 512;
const GITHUB_TIMEOUT_MS = 45_000;

export function normalizeOptions(input: Partial<CheckOptions>): CheckOptions {
  const codexModel = String(input.codexModel || "gpt-5").trim() || "gpt-5";
  const timeoutSeconds = clampInt(input.timeoutSeconds, 5, 120, DEFAULT_TIMEOUT_SECONDS);
  const workers = clampInt(input.workers, 1, 500, DEFAULT_WORKERS);
  return {
    codexModel,
    codexUsageLimitOnly: Boolean(input.codexUsageLimitOnly),
    timeoutSeconds,
    workers
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function utcNowText(date: Date = new Date()): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatDateUtc(value: Date | null): string {
  if (!value) {
    return "";
  }
  return utcNowText(value);
}

function shortText(text: string, limit = 260): string {
  const compact = (text || "").replace(/\s+/g, " ").trim();
  return compact.slice(0, limit);
}

function parseIsoTime(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }

  let normalized = text;
  if (normalized.endsWith("Z")) {
    normalized = normalized.slice(0, -1) + "+00:00";
  } else if (!/[+-]\d{2}:\d{2}$/.test(normalized)) {
    normalized += "+00:00";
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function parseJwtExp(token: unknown): Date | null {
  if (typeof token !== "string" || token.split(".").length !== 3) {
    return null;
  }

  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const exp = parsed.exp;
    if (typeof exp === "number" && Number.isInteger(exp) && exp > 0) {
      return new Date(exp * 1000);
    }
  } catch {
    return null;
  }
  return null;
}

function offlineExpired(metadata: JsonValue, nowUtc: Date): { expired: boolean; reason: string; accessExp: Date | null } {
  const accessExp = parseJwtExp(metadata.access_token);
  if (accessExp && accessExp.getTime() <= nowUtc.getTime()) {
    return { expired: true, reason: "access_token jwt exp is in the past", accessExp };
  }

  const expiredField = parseIsoTime(metadata.expired);
  if (expiredField && expiredField.getTime() <= nowUtc.getTime()) {
    return { expired: true, reason: "expired field is in the past", accessExp };
  }
  return { expired: false, reason: "", accessExp };
}

function pickNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") {
      const text = value.trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function nestedTokenObject(metadata: JsonValue): JsonValue {
  const tokenValue = metadata.token;
  if (tokenValue && typeof tokenValue === "object" && !Array.isArray(tokenValue)) {
    return tokenValue as JsonValue;
  }
  return {};
}

function resolveAccessToken(metadata: JsonValue): string {
  const tokenObj = nestedTokenObject(metadata);
  return pickNonEmptyString(metadata.access_token, tokenObj.access_token);
}

function resolveGoogleRefreshPayload(metadata: JsonValue): {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tokenUri: string;
} {
  const tokenObj = nestedTokenObject(metadata);
  const refreshToken = pickNonEmptyString(metadata.refresh_token, tokenObj.refresh_token);
  const clientId = pickNonEmptyString(metadata.client_id, tokenObj.client_id);
  const clientSecret = pickNonEmptyString(metadata.client_secret, tokenObj.client_secret);
  const tokenUri = pickNonEmptyString(metadata.token_uri, tokenObj.token_uri) || "https://oauth2.googleapis.com/token";
  return { refreshToken, clientId, clientSecret, tokenUri };
}

function buildCodexProbePayload(model: string): Record<string, unknown> {
  const targetModel = model.trim() || "gpt-5";
  return {
    model: targetModel,
    instructions: "You are a coding assistant.",
    input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
    store: false,
    stream: true
  };
}

function isUsageLimitReached(responseText: string): boolean {
  const lowerText = (responseText || "").toLowerCase();
  if (lowerText.includes("usage_limit_reached") || lowerText.includes("usage limit has been reached")) {
    return true;
  }
  try {
    const payload = JSON.parse(responseText || "{}") as Record<string, unknown>;
    const errorObject = payload.error;
    if (errorObject && typeof errorObject === "object" && !Array.isArray(errorObject)) {
      const errorType = String((errorObject as Record<string, unknown>).type || "").trim().toLowerCase();
      return errorType === "usage_limit_reached";
    }
  } catch {
    return false;
  }
  return false;
}

function classifyCodexResponse(statusCode: number, responseText: string): { status: string; reason: string } {
  const lowerText = responseText.toLowerCase();
  if (
    statusCode === 401 &&
    (lowerText.includes("token_invalidated") || lowerText.includes("authentication token has been invalidated"))
  ) {
    return { status: "invalidated", reason: "codex token invalidated" };
  }
  if (statusCode === 401 && (lowerText.includes("deactivated") || lowerText.includes("account has been deactivated"))) {
    return { status: "deactivated", reason: "codex account deactivated" };
  }
  if (statusCode === 401) {
    return { status: "unauthorized", reason: "codex unauthorized" };
  }
  if (isUsageLimitReached(responseText)) {
    return { status: "usage_limited", reason: "codex usage limit reached" };
  }
  if (statusCode === 429) {
    return { status: "rate_limited", reason: "codex rate limited" };
  }
  if (lowerText.includes("model is not supported when using codex with a chatgpt account")) {
    return { status: "model_unsupported", reason: "codex model unsupported for chatgpt account" };
  }
  if (
    lowerText.includes("instructions are required") ||
    lowerText.includes("input must be a list") ||
    lowerText.includes("store must be set to false") ||
    lowerText.includes("stream must be set to true")
  ) {
    return { status: "probe_mismatch", reason: "codex probe payload rejected" };
  }
  if (statusCode === 200 || statusCode === 201) {
    return { status: "active", reason: "codex token appears usable" };
  }
  if (statusCode === 400) {
    return { status: "bad_request", reason: "codex bad request" };
  }
  if (statusCode === 402) {
    return { status: "payment_required", reason: "codex payment required" };
  }
  if (statusCode === 403) {
    return { status: "forbidden", reason: "codex forbidden" };
  }
  if (statusCode === 404) {
    return { status: "not_found", reason: "codex endpoint not found" };
  }
  if (statusCode === 409) {
    return { status: "conflict", reason: "codex conflict" };
  }
  if (statusCode === 422) {
    return { status: "unprocessable", reason: "codex unprocessable request" };
  }
  if (statusCode >= 500) {
    return { status: "server_error", reason: "codex server error" };
  }
  return { status: "unknown", reason: "codex unexpected response" };
}

function classifyCodexUsageLimitOnly(statusCode: number, responseText: string): { status: string; reason: string } {
  if (isUsageLimitReached(responseText)) {
    return { status: "usage_limited", reason: "codex usage limit reached" };
  }
  const classified = classifyCodexResponse(statusCode, responseText);
  if (classified.status === "active") {
    return { status: "usage_not_limited", reason: "codex usage limit not reached" };
  }
  return classified;
}

function classifyGoogleResponse(statusCode: number, responseText: string): { status: string; reason: string } {
  const lowerText = responseText.toLowerCase();
  if (statusCode === 200) {
    return { status: "active", reason: "google oauth token appears usable" };
  }
  if (statusCode === 401 && (lowerText.includes("invalid") || lowerText.includes("unauthorized"))) {
    return { status: "invalidated", reason: "google oauth token invalid" };
  }
  if (statusCode === 403) {
    return { status: "active", reason: "google oauth token active but scope may be limited" };
  }
  if (statusCode === 401) {
    return { status: "unauthorized", reason: "google oauth unauthorized" };
  }
  return { status: "unknown", reason: "google oauth unexpected response" };
}

async function httpJsonRequest(
  url: string,
  method: string,
  headers: HeadersInit,
  body: BodyInit | undefined,
  timeoutSeconds: number,
  maxReadBytes = 0,
  skipSuccessBody = false
): Promise<HttpResponse> {
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal
  });

  if (skipSuccessBody && response.ok) {
    await response.body?.cancel();
    return { statusCode: response.status, responseText: "" };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const payload = maxReadBytes > 0 ? bytes.subarray(0, maxReadBytes) : bytes;
  return {
    statusCode: response.status,
    responseText: payload.toString("utf8")
  };
}

async function codexProbeRequest(metadata: JsonValue, timeoutSeconds: number, model: string): Promise<HttpResponse> {
  const token = pickNonEmptyString(metadata.access_token);
  if (!token) {
    return { statusCode: 0, responseText: "" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Openai-Beta": "responses=experimental",
    Version: "0.98.0",
    Originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.98.0"
  };

  const accountId = pickNonEmptyString(metadata.account_id);
  if (accountId) {
    headers["Chatgpt-Account-Id"] = accountId;
  }

  return httpJsonRequest(
    "https://chatgpt.com/backend-api/codex/responses",
    "POST",
    headers,
    JSON.stringify(buildCodexProbePayload(model)),
    timeoutSeconds,
    MAX_DETAIL_BYTES,
    true
  );
}

async function refreshGoogleAccessToken(
  metadata: JsonValue,
  timeoutSeconds: number
): Promise<{ token: string; code: number; reason: string; text: string }> {
  const { refreshToken, clientId, clientSecret, tokenUri } = resolveGoogleRefreshPayload(metadata);
  if (!refreshToken) {
    return { token: "", code: 0, reason: "google refresh_token is missing", text: "" };
  }
  if (!clientId || !clientSecret) {
    return { token: "", code: 0, reason: "google client credentials are missing", text: "" };
  }

  const payload = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  }).toString();

  const { statusCode, responseText } = await httpJsonRequest(
    tokenUri,
    "POST",
    { "Content-Type": "application/x-www-form-urlencoded" },
    payload,
    timeoutSeconds
  );

  if (statusCode !== 200) {
    return { token: "", code: statusCode, reason: "google refresh failed", text: responseText };
  }

  try {
    const data = JSON.parse(responseText || "{}") as Record<string, unknown>;
    const accessToken = pickNonEmptyString(data.access_token);
    if (!accessToken) {
      return {
        token: "",
        code: statusCode,
        reason: "google refresh response missing access_token",
        text: responseText
      };
    }
    return { token: accessToken, code: statusCode, reason: "google refresh succeeded", text: responseText };
  } catch {
    return { token: "", code: statusCode, reason: "google refresh returned non-json payload", text: responseText };
  }
}

async function googleTokenInfoRequest(token: string, timeoutSeconds: number): Promise<HttpResponse> {
  const query = new URLSearchParams({ access_token: token }).toString();
  return httpJsonRequest(`https://oauth2.googleapis.com/tokeninfo?${query}`, "GET", {}, undefined, timeoutSeconds);
}

async function checkCodex(
  metadata: JsonValue,
  timeoutSeconds: number,
  model: string,
  usageLimitOnly: boolean
): Promise<{ status: string; code: number; reason: string; text: string }> {
  const token = pickNonEmptyString(metadata.access_token);
  if (!token) {
    return { status: "missing_token", code: 0, reason: "access_token is missing", text: "" };
  }

  const { statusCode, responseText } = await codexProbeRequest(metadata, timeoutSeconds, model);
  const classified = usageLimitOnly
    ? classifyCodexUsageLimitOnly(statusCode, responseText)
    : classifyCodexResponse(statusCode, responseText);
  return { status: classified.status, code: statusCode, reason: classified.reason, text: responseText };
}

async function checkGoogleOauth(
  metadata: JsonValue,
  timeoutSeconds: number
): Promise<{ status: string; code: number; reason: string; text: string }> {
  let token = resolveAccessToken(metadata);
  if (!token) {
    const refreshed = await refreshGoogleAccessToken(metadata, timeoutSeconds);
    if (!refreshed.token) {
      if (refreshed.reason.includes("refresh_token is missing") || refreshed.reason.includes("client credentials are missing")) {
        return { status: "missing_token", code: 0, reason: "access_token is missing", text: "" };
      }
      return { status: "unknown", code: refreshed.code > 0 ? refreshed.code : 0, reason: refreshed.reason, text: refreshed.text };
    }
    token = refreshed.token;
  }

  let { statusCode, responseText } = await googleTokenInfoRequest(token, timeoutSeconds);
  let lowerText = responseText.toLowerCase();

  if (statusCode === 200) {
    return { status: "active", code: statusCode, reason: "google tokeninfo accepted token", text: responseText };
  }

  if (statusCode === 400 || statusCode === 401) {
    const refreshed = await refreshGoogleAccessToken(metadata, timeoutSeconds);
    if (refreshed.token) {
      const retry = await googleTokenInfoRequest(refreshed.token, timeoutSeconds);
      statusCode = retry.statusCode;
      responseText = retry.responseText;
      lowerText = responseText.toLowerCase();
      if (statusCode === 200) {
        return { status: "active", code: statusCode, reason: "google token refreshed and accepted", text: responseText };
      }
      if (statusCode === 400 && (lowerText.includes("invalid_token") || lowerText.includes("invalid"))) {
        return { status: "invalidated", code: statusCode, reason: "google token invalid after refresh", text: responseText };
      }
      if (statusCode === 401) {
        return { status: "unauthorized", code: statusCode, reason: "google token unauthorized after refresh", text: responseText };
      }
      return {
        status: "unknown",
        code: statusCode,
        reason: "google tokeninfo unexpected response after refresh",
        text: responseText
      };
    }

    if (refreshed.code > 0 && refreshed.reason === "google refresh failed") {
      const refreshLower = (refreshed.text || "").toLowerCase();
      if (refreshLower.includes("invalid_grant")) {
        return { status: "invalidated", code: refreshed.code, reason: "google refresh token invalid", text: refreshed.text };
      }
    }
  }

  if (statusCode === 400 && (lowerText.includes("invalid_token") || lowerText.includes("invalid"))) {
    return { status: "invalidated", code: statusCode, reason: "google token invalid", text: responseText };
  }
  if (statusCode === 401) {
    return { status: "unauthorized", code: statusCode, reason: "google token unauthorized", text: responseText };
  }
  return { status: "unknown", code: statusCode, reason: "google tokeninfo unexpected response", text: responseText };
}

function summarize(results: CheckResult[]): CheckSummary {
  const byStatus: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const byProviderStatus: Record<string, Record<string, number>> = {};

  for (const result of results) {
    byStatus[result.status] = (byStatus[result.status] || 0) + 1;
    byProvider[result.provider] = (byProvider[result.provider] || 0) + 1;
    byProviderStatus[result.provider] ||= {};
    byProviderStatus[result.provider][result.status] = (byProviderStatus[result.provider][result.status] || 0) + 1;
  }

  return {
    by_status: sortObject(byStatus),
    by_provider: sortObject(byProvider),
    by_provider_status: sortNestedObject(byProviderStatus)
  };
}

function sortObject(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function sortNestedObject(record: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, sortObject(value)])
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      result[current] = await work(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return result;
}

function normalizeArchiveInputs(archives: ArchiveInput[]): ArchiveInput[] {
  const nameCounter = new Map<string, number>();
  return archives.map((archive) => {
    const original = (archive.name || "").trim() || "auths.zip";
    const count = nameCounter.get(original) || 0;
    nameCounter.set(original, count + 1);
    if (count === 0) {
      return { ...archive, name: original };
    }
    const extIndex = original.lastIndexOf(".");
    const base = extIndex > 0 ? original.slice(0, extIndex) : original;
    const ext = extIndex > 0 ? original.slice(extIndex) : "";
    return { ...archive, name: `${base}(${count + 1})${ext}` };
  });
}

async function collectArchiveCredentials(archivesInput: ArchiveInput[]): Promise<CredentialInput[]> {
  const archives = normalizeArchiveInputs(archivesInput);
  const items: CredentialInput[] = [];
  for (const archive of archives) {
    const zip = await JSZip.loadAsync(Buffer.from(archive.arrayBuffer));
    const jsonFiles = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".json"));
    for (const entry of jsonFiles) {
      items.push({
        origin: "upload",
        source: archive.name,
        path: entry.name,
        rawText: await entry.async("string")
      });
    }
  }
  return items;
}

async function checkCredential(
  input: CredentialInput,
  options: CheckOptions
): Promise<CheckResult> {
  const begin = Date.now();
  const nowUtc = new Date();
  const checkedAt = utcNowText(nowUtc);
  const filename = input.path.split("/").at(-1) || input.path;

  let metadata: JsonValue;
  try {
    const parsed = JSON.parse(input.rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("json root is not an object");
    }
    metadata = parsed as JsonValue;
  } catch (error) {
    return {
      id: `${input.origin}:${input.source}:${input.path}`,
      source: input.source,
      origin: input.origin,
      file: filename,
      path: input.path,
      provider: "unknown",
      email: "",
      status: "check_error",
      http_status: null,
      reason: "invalid json",
      detail: shortText(String(error)),
      expired_field: "",
      access_token_exp_utc: "",
      checked_at_utc: checkedAt,
      elapsed_ms: Date.now() - begin
    };
  }

  const provider = pickNonEmptyString(metadata.type).toLowerCase() || "unknown";
  const email = pickNonEmptyString(metadata.email);
  const expiredText = pickNonEmptyString(metadata.expired);
  const offline = offlineExpired(metadata, nowUtc);
  const accessExpText = formatDateUtc(offline.accessExp);

  let status = "unknown";
  let httpStatus: number | null = null;
  let reason = "no checker available";
  let detail = "";

  try {
    if (provider === "codex") {
      const checked = await checkCodex(metadata, options.timeoutSeconds, options.codexModel, options.codexUsageLimitOnly);
      status = checked.status;
      httpStatus = checked.code > 0 ? checked.code : null;
      reason = checked.reason;
      detail = shortText(checked.text);
    } else if (provider === "antigravity" || provider === "gemini" || provider === "gemini-cli") {
      if (options.codexUsageLimitOnly) {
        status = "skipped_non_codex";
        reason = "codex usage-limit mode only checks codex provider";
      } else {
        const checked = await checkGoogleOauth(metadata, options.timeoutSeconds);
        status = checked.status;
        httpStatus = checked.code > 0 ? checked.code : null;
        reason = checked.reason;
        detail = shortText(checked.text);
      }
    } else if (options.codexUsageLimitOnly) {
      status = "skipped_non_codex";
      reason = "codex usage-limit mode only checks codex provider";
    } else if (offline.expired) {
      status = "expired_by_time";
      reason = offline.reason;
    } else {
      status = "unknown";
      reason = "online checker not implemented for this provider";
    }
  } catch (error) {
    status = "check_error";
    reason = "provider check failed";
    detail = shortText(String(error));
  }

  if ((status === "unknown" || status === "active") && offline.expired) {
    status = "expired_by_time";
    reason = offline.reason;
  }

  return {
    id: `${input.origin}:${input.source}:${input.path}`,
    source: input.source,
    origin: input.origin,
    file: filename,
    path: input.path,
    provider,
    email,
    status,
    http_status: httpStatus,
    reason,
    detail,
    expired_field: expiredText,
    access_token_exp_utc: accessExpText,
    checked_at_utc: checkedAt,
    elapsed_ms: Date.now() - begin
  };
}

async function checkCredentials(
  credentials: CredentialInput[],
  inputOptions: Partial<CheckOptions>,
  mode: "upload" | "repo",
  sourceLabel: string
): Promise<CheckReport> {
  if (credentials.length === 0) {
    throw new Error(mode === "upload" ? "上传的 zip 中没有找到 .json 凭证文件" : "仓库 auth 目录下没有 .json 凭证文件");
  }

  const options = normalizeOptions(inputOptions);
  const started = Date.now();

  const rawResults = await mapWithConcurrency(credentials, options.workers, (item) => checkCredential(item, options));
  const results = [...rawResults].sort((a, b) => {
    if (a.source !== b.source) {
      return a.source.localeCompare(b.source);
    }
    if (a.file !== b.file) {
      return a.file.localeCompare(b.file);
    }
    return a.path.localeCompare(b.path);
  });

  return {
    checked_at_utc: utcNowText(),
    duration_seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    mode,
    source_label: sourceLabel,
    codex_model: options.codexModel,
    codex_usage_limit_only: options.codexUsageLimitOnly,
    total: results.length,
    summary: summarize(results),
    results
  };
}

function parseGithubRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const text = (repoUrl || "").trim();
  if (!text) {
    throw new Error("repoUrl 不能为空");
  }

  if (text.startsWith("git@github.com:")) {
    const suffix = text.slice("git@github.com:".length).replace(/\.git$/i, "");
    const [owner, repo] = suffix.split("/");
    if (owner && repo) {
      return { owner, repo };
    }
  }

  const parsed = new URL(text);
  if (parsed.hostname !== "github.com") {
    throw new Error("repoUrl 必须是 github.com 仓库地址");
  }
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) {
    throw new Error("repoUrl 格式无效，示例: https://github.com/owner/repo");
  }
  return {
    owner: parts[0],
    repo: parts[1].replace(/\.git$/i, "")
  };
}

function normalizeRepoConfig(input: Partial<RepoConfig>): NormalizedRepoConfig {
  const repoUrl = (input.repoUrl || "").trim();
  const githubToken = (input.githubToken || "").trim();
  const branch = (input.branch || "master").trim() || "master";
  const authSubdir = (input.authSubdir || "auths").trim().replace(/^\/+|\/+$/g, "");
  if (!repoUrl) {
    throw new Error("repoUrl 不能为空");
  }
  if (!githubToken) {
    throw new Error("githubToken 不能为空");
  }
  const { owner, repo } = parseGithubRepoUrl(repoUrl);
  return { repoUrl, githubToken, branch, authSubdir, owner, repo };
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

async function githubRequest(
  config: NormalizedRepoConfig,
  url: string,
  method: "GET" | "PUT" | "DELETE" = "GET",
  body?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
  });

  const text = await response.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: shortText(text, 800) };
  }

  if (!response.ok) {
    const errorText =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? String((payload as Record<string, unknown>).message || text || "unknown error")
        : String(text || "unknown error");
    if (response.status === 403 && /rate limit exceeded/i.test(errorText)) {
      const resetUnix = Number(response.headers.get("x-ratelimit-reset") || "0");
      const remaining = response.headers.get("x-ratelimit-remaining") || "";
      const resetAt = resetUnix > 0 ? utcNowText(new Date(resetUnix * 1000)) : "";
      throw new Error(
        `GitHub API 403: rate limit exceeded` +
          (remaining ? ` (remaining=${remaining})` : "") +
          (resetAt ? `，预计重置时间 ${resetAt}` : "") +
          `。建议稍后重试，或减少单次操作规模。`
      );
    }
    throw new Error(`GitHub API ${response.status}: ${shortText(errorText, 500)}`);
  }
  return payload;
}

function buildRepoGitUrl(config: NormalizedRepoConfig, suffix: string): string {
  const base = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  return `${base}${suffix}`;
}

function parseGitTreePayload(payload: unknown): { entries: GitTreeEntry[]; truncated: boolean } {
  const obj = asObject(payload);
  if (!obj) {
    throw new Error("GitHub tree 返回格式异常");
  }
  const tree = obj.tree;
  if (!Array.isArray(tree)) {
    throw new Error("GitHub tree 缺少 tree[]");
  }
  const truncated = Boolean(obj.truncated);
  const entries: GitTreeEntry[] = [];
  for (const item of tree) {
    const entry = asObject(item);
    if (!entry) {
      continue;
    }
    const path = String(entry.path || "");
    const type = String(entry.type || "");
    const sha = String(entry.sha || "");
    if (!path || !sha || (type !== "tree" && type !== "blob")) {
      continue;
    }
    entries.push({ path, type: type as "tree" | "blob", sha });
  }
  return { entries, truncated };
}

async function getBranchCommitSha(config: NormalizedRepoConfig): Promise<string> {
  const payload = await githubRequest(
    config,
    buildRepoGitUrl(config, `/branches/${encodeURIComponent(config.branch)}`),
    "GET"
  );
  const obj = asObject(payload);
  const commit = asObject(obj?.commit);
  const sha = String(commit?.sha || "");
  if (!sha) {
    throw new Error(`无法读取分支 ${config.branch} 的 commit sha`);
  }
  return sha;
}

async function getCommitTreeSha(config: NormalizedRepoConfig, commitSha: string): Promise<string> {
  const payload = await githubRequest(
    config,
    buildRepoGitUrl(config, `/git/commits/${encodeURIComponent(commitSha)}`),
    "GET"
  );
  const obj = asObject(payload);
  const tree = asObject(obj?.tree);
  const sha = String(tree?.sha || "");
  if (!sha) {
    throw new Error(`无法读取 commit ${commitSha} 的 tree sha`);
  }
  return sha;
}

async function getTree(config: NormalizedRepoConfig, treeSha: string, recursive: boolean): Promise<{ entries: GitTreeEntry[]; truncated: boolean }> {
  const url = buildRepoGitUrl(
    config,
    `/git/trees/${encodeURIComponent(treeSha)}${recursive ? "?recursive=1" : ""}`
  );
  const payload = await githubRequest(config, url, "GET");
  return parseGitTreePayload(payload);
}

async function findSubtreeSha(config: NormalizedRepoConfig, rootTreeSha: string, dirPath: string): Promise<string> {
  const segments = dirPath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  let currentSha = rootTreeSha;
  for (const segment of segments) {
    const { entries } = await getTree(config, currentSha, false);
    const next = entries.find((entry) => entry.type === "tree" && entry.path === segment);
    if (!next) {
      throw new Error(`仓库目录不存在: ${dirPath}`);
    }
    currentSha = next.sha;
  }
  return currentSha;
}

async function listRepoJsonFilesByTreeBfs(
  config: NormalizedRepoConfig,
  rootTreeSha: string,
  rootPath: string
): Promise<RepoFileEntry[]> {
  const queue: Array<{ sha: string; prefix: string }> = [{ sha: rootTreeSha, prefix: rootPath }];
  const files: RepoFileEntry[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const { entries } = await getTree(config, current.sha, false);
    for (const entry of entries) {
      const fullPath = current.prefix ? `${current.prefix}/${entry.path}` : entry.path;
      if (entry.type === "tree") {
        queue.push({ sha: entry.sha, prefix: fullPath });
        continue;
      }
      if (!fullPath.toLowerCase().endsWith(".json")) {
        continue;
      }
      files.push({
        path: fullPath,
        name: fullPath.split("/").at(-1) || fullPath,
        sha: entry.sha
      });
    }
  }
  return files;
}

async function listRepoJsonFiles(config: NormalizedRepoConfig): Promise<RepoFileEntry[]> {
  const commitSha = await getBranchCommitSha(config);
  const repoRootTreeSha = await getCommitTreeSha(config, commitSha);
  const authTreeSha = await findSubtreeSha(config, repoRootTreeSha, config.authSubdir);

  const recursive = await getTree(config, authTreeSha, true);
  let files: RepoFileEntry[] = [];

  if (!recursive.truncated) {
    const rootPrefix = config.authSubdir ? `${config.authSubdir}/` : "";
    files = recursive.entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => ({
        path: rootPrefix ? `${rootPrefix}${entry.path}` : entry.path,
        name: entry.path.split("/").at(-1) || entry.path,
        sha: entry.sha
      }))
      .filter((entry) => entry.path.toLowerCase().endsWith(".json"));
  } else {
    files = await listRepoJsonFilesByTreeBfs(config, authTreeSha, config.authSubdir);
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function joinRepoPath(subdir: string, filename: string): string {
  const safeSubdir = subdir.replace(/^\/+|\/+$/g, "");
  if (!safeSubdir) {
    return filename;
  }
  return `${safeSubdir}/${filename}`;
}

function chooseUniqueTargetPath(authSubdir: string, filename: string, existingPaths: Set<string>): string {
  const cleaned = filename.replace(/[\\/:*?"<>|]+/g, "_") || "credential.json";
  const dot = cleaned.lastIndexOf(".");
  const base = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const ext = dot > 0 ? cleaned.slice(dot) : ".json";
  let counter = 0;
  while (true) {
    const suffix = counter === 0 ? "" : `-${counter}`;
    const candidate = joinRepoPath(authSubdir, `${base}${suffix}${ext}`);
    if (!existingPaths.has(candidate)) {
      return candidate;
    }
    counter += 1;
  }
}

function parseStatusSet(statuses: string[]): Set<string> {
  return new Set(
    statuses
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function shouldApplyByProvider(provider: string, scope: ProviderScope): boolean {
  if (scope === "all") {
    return true;
  }
  return provider.trim().toLowerCase() === "codex";
}

function pickMatchingRefs(
  refs: CleanupResultRef[],
  statusSet: Set<string>,
  providerScope: ProviderScope,
  origin: CheckOrigin
): CleanupResultRef[] {
  const selected: CleanupResultRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const refOrigin = (ref.origin || "").trim().toLowerCase();
    if (refOrigin !== origin) {
      continue;
    }
    const status = String(ref.status || "").trim().toLowerCase();
    const provider = String(ref.provider || "").trim().toLowerCase();
    const source = String(ref.source || "").trim();
    const path = String(ref.path || "").trim();
    if (!source || !path || !statusSet.has(status) || !shouldApplyByProvider(provider, providerScope)) {
      continue;
    }
    const key = `${source}:${path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push({ source, origin, path, status, provider });
  }
  return selected;
}

function trimToRepoRelativePath(zipPath: string): string {
  const normalized = zipPath.replace(/^\/+/, "").replace(/\\/g, "/");
  const firstSlash = normalized.indexOf("/");
  if (firstSlash < 0) {
    return "";
  }
  return normalized.slice(firstSlash + 1);
}

function isPathUnderDir(pathText: string, dir: string): boolean {
  const normalizedPath = pathText.replace(/^\/+|\/+$/g, "");
  const normalizedDir = dir.replace(/^\/+|\/+$/g, "");
  if (!normalizedDir) {
    return true;
  }
  return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`);
}

async function fetchRepoZipball(config: NormalizedRepoConfig): Promise<Buffer> {
  const url = buildRepoGitUrl(config, `/zipball/${encodeURIComponent(config.branch)}`);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
  });

  if (!response.ok) {
    const text = await response.text();
    const message = shortText(text, 500);
    throw new Error(`仓库 zipball 下载失败 (HTTP ${response.status}): ${message}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function collectRepoCredentialsFromZipball(config: NormalizedRepoConfig): Promise<CredentialInput[]> {
  const zipBuffer = await fetchRepoZipball(config);
  const zip = await JSZip.loadAsync(zipBuffer);
  const credentials: CredentialInput[] = [];
  const source = `repo:${config.owner}/${config.repo}@${config.branch}`;

  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.toLowerCase().endsWith(".json")) {
      continue;
    }

    const repoRelativePath = trimToRepoRelativePath(entry.name);
    if (!repoRelativePath || !isPathUnderDir(repoRelativePath, config.authSubdir)) {
      continue;
    }

    credentials.push({
      origin: "repo",
      source,
      path: repoRelativePath,
      rawText: await entry.async("string")
    });
  }

  return credentials.sort((a, b) => a.path.localeCompare(b.path));
}

export async function checkArchiveCredentials(
  archivesInput: ArchiveInput[],
  inputOptions: Partial<CheckOptions>
): Promise<CheckReport> {
  const credentials = await collectArchiveCredentials(archivesInput);
  return checkCredentials(credentials, inputOptions, "upload", `upload:${archivesInput.length} archive(s)`);
}

export async function checkGithubRepoCredentials(
  repoInput: Partial<RepoConfig>,
  inputOptions: Partial<CheckOptions>
): Promise<CheckReport> {
  const config = normalizeRepoConfig(repoInput);
  const credentials = await collectRepoCredentialsFromZipball(config);
  if (credentials.length === 0) {
    throw new Error(`仓库 ${config.owner}/${config.repo} 的 ${config.authSubdir} 下未找到 .json 凭证`);
  }

  return checkCredentials(
    credentials,
    inputOptions,
    "repo",
    `repo:${config.owner}/${config.repo}@${config.branch}/${config.authSubdir}`
  );
}

export async function cleanupArchiveCredentials(
  archivesInput: ArchiveInput[],
  deleteStatuses: string[],
  resultRefs: CleanupResultRef[],
  providerScope: ProviderScope
): Promise<{ zipBuffer: Buffer; deletedPaths: string[] }> {
  const archives = normalizeArchiveInputs(archivesInput);
  if (archives.length === 0) {
    throw new Error("缺少上传 zip");
  }
  const statusSet = parseStatusSet(deleteStatuses);
  if (statusSet.size === 0) {
    throw new Error("deleteStatuses 不能为空");
  }
  const targets = pickMatchingRefs(resultRefs, statusSet, providerScope, "upload");

  const refMap = new Map<string, Set<string>>();
  for (const ref of targets) {
    if (!refMap.has(ref.source)) {
      refMap.set(ref.source, new Set<string>());
    }
    refMap.get(ref.source)!.add(ref.path);
  }

  const deletedPaths: string[] = [];
  const cleanedArchiveBuffers: Array<{ name: string; buffer: Buffer }> = [];

  for (const archive of archives) {
    const zip = await JSZip.loadAsync(Buffer.from(archive.arrayBuffer));
    const archiveTargets = refMap.get(archive.name) || new Set<string>();
    for (const path of archiveTargets) {
      if (zip.file(path)) {
        zip.remove(path);
        deletedPaths.push(`${archive.name}:${path}`);
      }
    }
    const cleanedBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
    cleanedArchiveBuffers.push({ name: archive.name, buffer: cleanedBuffer });
  }

  if (cleanedArchiveBuffers.length === 1) {
    return {
      zipBuffer: cleanedArchiveBuffers[0].buffer,
      deletedPaths: deletedPaths.sort((a, b) => a.localeCompare(b))
    };
  }

  const bundle = new JSZip();
  for (const archive of cleanedArchiveBuffers) {
    bundle.file(archive.name, archive.buffer);
  }
  const bundleBuffer = await bundle.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
  return { zipBuffer: bundleBuffer, deletedPaths: deletedPaths.sort((a, b) => a.localeCompare(b)) };
}

export async function importCredentialsToGithubRepo(
  archivesInput: ArchiveInput[],
  resultRefs: CleanupResultRef[],
  importStatuses: string[],
  providerScope: ProviderScope,
  repoInput: Partial<RepoConfig>
): Promise<RepoImportResult> {
  const config = normalizeRepoConfig(repoInput);
  const archives = normalizeArchiveInputs(archivesInput);
  const statusSet = parseStatusSet(importStatuses);
  if (statusSet.size === 0) {
    throw new Error("importStatuses 不能为空");
  }
  const targets = pickMatchingRefs(resultRefs, statusSet, providerScope, "upload");
  if (targets.length === 0) {
    return { imported_paths: [], skipped_paths: [] };
  }

  const archiveMap = new Map<string, JSZip>();
  for (const archive of archives) {
    archiveMap.set(archive.name, await JSZip.loadAsync(Buffer.from(archive.arrayBuffer)));
  }

  const existingPaths = new Set((await listRepoJsonFiles(config)).map((item) => item.path));
  const importedPaths: string[] = [];
  const skippedPaths: string[] = [];

  for (const ref of targets) {
    const zip = archiveMap.get(ref.source);
    if (!zip) {
      skippedPaths.push(`${ref.source}:${ref.path}`);
      continue;
    }
    const file = zip.file(ref.path);
    if (!file) {
      skippedPaths.push(`${ref.source}:${ref.path}`);
      continue;
    }
    const fileContent = await file.async("string");
    const filename = ref.path.split("/").at(-1) || "credential.json";
    const targetPath = chooseUniqueTargetPath(config.authSubdir, filename, existingPaths);
    const putUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodeRepoPath(targetPath)}`;

    await githubRequest(config, putUrl, "PUT", {
      message: `import credential from 2apicheck (${ref.source}:${ref.path})`,
      content: Buffer.from(fileContent, "utf8").toString("base64"),
      branch: config.branch
    });
    existingPaths.add(targetPath);
    importedPaths.push(targetPath);
  }

  return {
    imported_paths: importedPaths.sort((a, b) => a.localeCompare(b)),
    skipped_paths: skippedPaths.sort((a, b) => a.localeCompare(b))
  };
}

export async function deleteCredentialsFromGithubRepo(
  resultRefs: CleanupResultRef[],
  deleteStatuses: string[],
  providerScope: ProviderScope,
  repoInput: Partial<RepoConfig>
): Promise<RepoDeleteResult> {
  const config = normalizeRepoConfig(repoInput);
  const statusSet = parseStatusSet(deleteStatuses);
  if (statusSet.size === 0) {
    throw new Error("deleteStatuses 不能为空");
  }
  const targets = pickMatchingRefs(resultRefs, statusSet, providerScope, "repo");
  if (targets.length === 0) {
    return { deleted_paths: [], failed_paths: [] };
  }

  const repoFiles = await listRepoJsonFiles(config);
  const shaByPath = new Map(repoFiles.map((item) => [item.path, item.sha]));

  const deletedPaths: string[] = [];
  const failedPaths: string[] = [];

  for (const target of targets) {
    try {
      const targetSha = shaByPath.get(target.path);
      if (!targetSha) {
        failedPaths.push(target.path);
        continue;
      }
      const deleteUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodeRepoPath(target.path)}`;
      await githubRequest(config, deleteUrl, "DELETE", {
        message: `delete credential by 2apicheck status=${target.status}`,
        sha: targetSha,
        branch: config.branch
      });
      deletedPaths.push(target.path);
    } catch {
      failedPaths.push(target.path);
    }
  }

  return {
    deleted_paths: deletedPaths.sort((a, b) => a.localeCompare(b)),
    failed_paths: failedPaths.sort((a, b) => a.localeCompare(b))
  };
}
