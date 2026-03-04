import JSZip from "jszip";
import {
  CheckOptions,
  CheckReport,
  CheckResult,
  CheckSummary,
  CleanupResultRef,
  ProviderScope
} from "@/lib/types";

interface HttpResponse {
  statusCode: number;
  responseText: string;
}

type JsonValue = Record<string, unknown>;

const DEFAULT_TIMEOUT_SECONDS = 35;
const DEFAULT_WORKERS = 120;
const MAX_DETAIL_BYTES = 512;

export function normalizeOptions(input: Partial<CheckOptions>): CheckOptions {
  const codexModel = String(input.codexModel || "gpt-5").trim() || "gpt-5";
  const timeoutSeconds = clampInt(input.timeoutSeconds, 5, 120, DEFAULT_TIMEOUT_SECONDS);
  const workers = clampInt(input.workers, 1, 300, DEFAULT_WORKERS);
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

async function checkJsonFile(
  filePath: string,
  rawText: string,
  options: CheckOptions
): Promise<CheckResult> {
  const begin = Date.now();
  const nowUtc = new Date();
  const checkedAt = utcNowText(nowUtc);
  const filename = filePath.split("/").at(-1) || filePath;

  let metadata: JsonValue;
  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("json root is not an object");
    }
    metadata = parsed as JsonValue;
  } catch (error) {
    return {
      file: filename,
      path: filePath,
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
    file: filename,
    path: filePath,
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

export async function checkArchiveCredentials(arrayBuffer: ArrayBuffer, inputOptions: Partial<CheckOptions>): Promise<CheckReport> {
  const options = normalizeOptions(inputOptions);
  const started = Date.now();
  const zip = await JSZip.loadAsync(Buffer.from(arrayBuffer));
  const jsonFiles = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".json"));

  if (jsonFiles.length === 0) {
    throw new Error("zip 内没有找到任何 .json 凭证文件");
  }

  const rawResults = await mapWithConcurrency(jsonFiles, options.workers, async (entry) => {
    const text = await entry.async("string");
    return checkJsonFile(entry.name, text, options);
  });
  const results = [...rawResults].sort((a, b) => a.file.localeCompare(b.file));

  return {
    checked_at_utc: utcNowText(),
    duration_seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
    mode: "upload",
    codex_model: options.codexModel,
    codex_usage_limit_only: options.codexUsageLimitOnly,
    total: results.length,
    summary: summarize(results),
    results
  };
}

export async function cleanupArchiveCredentials(
  arrayBuffer: ArrayBuffer,
  deleteStatuses: string[],
  resultRefs: CleanupResultRef[],
  providerScope: ProviderScope
): Promise<{ zipBuffer: Buffer; deletedPaths: string[] }> {
  const normalizedDeleteSet = new Set(
    deleteStatuses
      .map((status) => status.trim())
      .filter(Boolean)
      .map((status) => status.toLowerCase())
  );

  const refMap = new Map<string, CleanupResultRef>();
  for (const ref of resultRefs) {
    const normalizedPath = String(ref.path || "").trim();
    if (!normalizedPath) {
      continue;
    }
    refMap.set(normalizedPath, {
      path: normalizedPath,
      status: String(ref.status || "").trim().toLowerCase(),
      provider: String(ref.provider || "").trim().toLowerCase()
    });
  }

  const zip = await JSZip.loadAsync(Buffer.from(arrayBuffer));
  const deletedPaths: string[] = [];

  for (const [path, ref] of refMap.entries()) {
    if (!normalizedDeleteSet.has(ref.status)) {
      continue;
    }
    if (providerScope === "codex" && ref.provider !== "codex") {
      continue;
    }
    if (zip.file(path)) {
      zip.remove(path);
      deletedPaths.push(path);
    }
  }

  const zipBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
  return { zipBuffer, deletedPaths: deletedPaths.sort((a, b) => a.localeCompare(b)) };
}
