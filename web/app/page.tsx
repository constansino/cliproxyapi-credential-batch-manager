"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { CheckReport, ProviderScope } from "@/lib/types";

const DEFAULT_DELETE_STATUSES = [
  "invalidated",
  "deactivated",
  "unauthorized",
  "expired_by_time",
  "missing_token",
  "check_error"
];

const TABLE_LIMIT = 200;

function classForStatus(status: string): string {
  if (status === "active" || status === "usage_not_limited") {
    return "status-pill status-ok";
  }
  if (status === "usage_limited" || status === "rate_limited") {
    return "status-pill status-warn";
  }
  return "status-pill status-bad";
}

export default function HomePage(): React.ReactElement {
  const [archive, setArchive] = useState<File | null>(null);
  const [codexModel, setCodexModel] = useState("gpt-5");
  const [timeoutSeconds, setTimeoutSeconds] = useState(35);
  const [workers, setWorkers] = useState(120);
  const [codexUsageLimitOnly, setCodexUsageLimitOnly] = useState(false);

  const [report, setReport] = useState<CheckReport | null>(null);
  const [error, setError] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [lastCleanupInfo, setLastCleanupInfo] = useState("");

  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [providerScope, setProviderScope] = useState<ProviderScope>("codex");

  const statusKeys = useMemo(() => Object.keys(report?.summary.by_status || {}), [report]);

  useEffect(() => {
    if (!report) {
      setSelectedStatuses([]);
      return;
    }
    setSelectedStatuses(DEFAULT_DELETE_STATUSES.filter((status) => statusKeys.includes(status)));
  }, [report, statusKeys]);

  function toggleStatus(status: string): void {
    setSelectedStatuses((prev) => {
      if (prev.includes(status)) {
        return prev.filter((item) => item !== status);
      }
      return [...prev, status];
    });
  }

  function pickUnavailableCodexStatuses(): void {
    if (!report) {
      return;
    }
    const set = new Set<string>();
    for (const result of report.results) {
      if (result.provider !== "codex") {
        continue;
      }
      if (result.status === "active" || result.status === "usage_not_limited") {
        continue;
      }
      set.add(result.status);
    }
    setSelectedStatuses(Array.from(set).sort((a, b) => a.localeCompare(b)));
  }

  async function submitCheck(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLastCleanupInfo("");
    setError("");
    if (!archive) {
      setError("请先上传 auths.zip");
      return;
    }

    setIsChecking(true);
    try {
      const form = new FormData();
      form.append("archive", archive);
      form.append("codexModel", codexModel);
      form.append("timeoutSeconds", String(timeoutSeconds));
      form.append("workers", String(workers));
      form.append("codexUsageLimitOnly", String(codexUsageLimitOnly));

      const response = await fetch("/api/check", {
        method: "POST",
        body: form
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload?.error || "检查失败"));
      }
      setReport(payload as CheckReport);
    } catch (err) {
      const message = err instanceof Error ? err.message : "检查失败";
      setError(message);
      setReport(null);
    } finally {
      setIsChecking(false);
    }
  }

  async function downloadCleanedZip(): Promise<void> {
    if (!archive || !report) {
      return;
    }
    if (selectedStatuses.length === 0) {
      setError("先选择要删除的状态");
      return;
    }

    setError("");
    setLastCleanupInfo("");
    setIsCleaning(true);
    try {
      const form = new FormData();
      form.append("archive", archive);
      form.append("deleteStatuses", selectedStatuses.join(","));
      form.append("providerScope", providerScope);
      form.append(
        "resultRefs",
        JSON.stringify(
          report.results.map((item) => ({
            path: item.path,
            status: item.status,
            provider: item.provider
          }))
        )
      );

      const response = await fetch("/api/cleanup", {
        method: "POST",
        body: form
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(String(payload?.error || "清理失败"));
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `auths.cleaned.${Date.now()}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      const deletedCount = Number(response.headers.get("X-Deleted-Count") || 0);
      setLastCleanupInfo(`已生成清理包，删除 ${deletedCount} 个凭证文件。`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "清理失败";
      setError(message);
    } finally {
      setIsCleaning(false);
    }
  }

  return (
    <main className="page-wrap">
      <div className="hero-backdrop" />
      <section className="panel hero">
        <p className="hero-label">2ApiCheck</p>
        <h1>批量凭证检查 + 清理打包</h1>
        <p>上传 `auths.zip` 后在线检测 Codex / Gemini 凭证状态，支持一键导出清理后的 zip。</p>
      </section>

      <section className="panel">
        <form className="form-grid" onSubmit={submitCheck}>
          <label className="field">
            <span>上传 ZIP</span>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                setArchive(file);
              }}
            />
          </label>

          <label className="field">
            <span>Codex 模型</span>
            <input value={codexModel} onChange={(event) => setCodexModel(event.target.value)} placeholder="gpt-5" />
          </label>

          <label className="field">
            <span>超时秒数</span>
            <input
              type="number"
              min={5}
              max={120}
              value={timeoutSeconds}
              onChange={(event) => setTimeoutSeconds(Number(event.target.value || 35))}
            />
          </label>

          <label className="field">
            <span>并发</span>
            <input
              type="number"
              min={1}
              max={300}
              value={workers}
              onChange={(event) => setWorkers(Number(event.target.value || 120))}
            />
          </label>

          <label className="field toggle">
            <input
              type="checkbox"
              checked={codexUsageLimitOnly}
              onChange={(event) => setCodexUsageLimitOnly(event.target.checked)}
            />
            <span>仅检查 Codex Usage Limit</span>
          </label>

          <button className="btn btn-main" type="submit" disabled={isChecking}>
            {isChecking ? "检查中..." : "开始检查"}
          </button>
        </form>

        {error ? <p className="error-text">{error}</p> : null}
        {archive ? <p className="file-info">当前文件：{archive.name}</p> : null}
      </section>

      {report ? (
        <>
          <section className="panel">
            <h2>检查结果</h2>
            <p>
              总数 {report.total}，耗时 {report.duration_seconds}s，模式{" "}
              {report.codex_usage_limit_only ? "usage-limit-only" : "full-check"}
            </p>
            <div className="card-grid">
              {Object.entries(report.summary.by_status).map(([status, count]) => (
                <article className="mini-card" key={status}>
                  <span className={classForStatus(status)}>{status}</span>
                  <strong>{count}</strong>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>清理打包</h2>
            <div className="cleanup-row">
              <button className="btn" type="button" onClick={pickUnavailableCodexStatuses}>
                仅选不可用 Codex 状态
              </button>
              <label className="scope-select">
                <span>删除范围</span>
                <select value={providerScope} onChange={(event) => setProviderScope(event.target.value as ProviderScope)}>
                  <option value="codex">只删 Codex</option>
                  <option value="all">全部 provider</option>
                </select>
              </label>
              <button className="btn btn-danger" type="button" onClick={downloadCleanedZip} disabled={isCleaning}>
                {isCleaning ? "打包中..." : "下载清理后 ZIP"}
              </button>
            </div>

            <div className="chip-wrap">
              {statusKeys.map((status) => (
                <label className="chip-option" key={status}>
                  <input type="checkbox" checked={selectedStatuses.includes(status)} onChange={() => toggleStatus(status)} />
                  <span>{status}</span>
                </label>
              ))}
            </div>
            {lastCleanupInfo ? <p className="ok-text">{lastCleanupInfo}</p> : null}
          </section>

          <section className="panel">
            <h2>明细（前 {TABLE_LIMIT} 条）</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>file</th>
                    <th>provider</th>
                    <th>status</th>
                    <th>http</th>
                    <th>reason</th>
                  </tr>
                </thead>
                <tbody>
                  {report.results.slice(0, TABLE_LIMIT).map((item) => (
                    <tr key={`${item.path}-${item.status}`}>
                      <td title={item.path}>{item.file}</td>
                      <td>{item.provider}</td>
                      <td>
                        <span className={classForStatus(item.status)}>{item.status}</span>
                      </td>
                      <td>{item.http_status ?? "-"}</td>
                      <td title={item.detail || item.reason}>{item.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
