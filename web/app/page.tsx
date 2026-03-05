"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { CheckReport, CleanupResultRef, ProviderScope } from "@/lib/types";

const DEFAULT_DELETE_STATUSES = [
  "invalidated",
  "deactivated",
  "unauthorized",
  "expired_by_time",
  "missing_token",
  "check_error"
];
const DEFAULT_IMPORT_STATUSES = ["usage_not_limited", "active"];
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

function toggleItem(list: string[], value: string): string[] {
  if (list.includes(value)) {
    return list.filter((item) => item !== value);
  }
  return [...list, value];
}

function toResultRefs(report: CheckReport): CleanupResultRef[] {
  return report.results.map((item) => ({
    source: item.source,
    origin: item.origin,
    path: item.path,
    status: item.status,
    provider: item.provider
  }));
}

export default function HomePage(): React.ReactElement {
  const [archives, setArchives] = useState<File[]>([]);
  const [codexModel, setCodexModel] = useState("gpt-5");
  const [timeoutSeconds, setTimeoutSeconds] = useState(35);
  const [workers, setWorkers] = useState(120);
  const [codexUsageLimitOnly, setCodexUsageLimitOnly] = useState(false);

  const [repoUrl, setRepoUrl] = useState("https://github.com/constansino/conscliproxyapi");
  const [repoBranch, setRepoBranch] = useState("master");
  const [repoAuthSubdir, setRepoAuthSubdir] = useState("auths");
  const [githubToken, setGithubToken] = useState("");

  const [report, setReport] = useState<CheckReport | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isCheckingUpload, setIsCheckingUpload] = useState(false);
  const [isCheckingRepo, setIsCheckingRepo] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [isImportingRepo, setIsImportingRepo] = useState(false);
  const [isDeletingRepo, setIsDeletingRepo] = useState(false);

  const [providerScope, setProviderScope] = useState<ProviderScope>("codex");
  const [deleteStatuses, setDeleteStatuses] = useState<string[]>([]);
  const [importStatuses, setImportStatuses] = useState<string[]>([]);

  const statusKeys = useMemo(() => Object.keys(report?.summary.by_status || {}), [report]);

  useEffect(() => {
    if (!report) {
      setDeleteStatuses([]);
      setImportStatuses([]);
      return;
    }
    setDeleteStatuses(DEFAULT_DELETE_STATUSES.filter((status) => statusKeys.includes(status)));
    const nextImport = DEFAULT_IMPORT_STATUSES.filter((status) => statusKeys.includes(status));
    if (nextImport.length > 0) {
      setImportStatuses(nextImport);
    } else if (statusKeys.includes("active")) {
      setImportStatuses(["active"]);
    } else {
      setImportStatuses([]);
    }
  }, [report, statusKeys]);

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
    setDeleteStatuses(Array.from(set).sort((a, b) => a.localeCompare(b)));
  }

  function pickImportableStatuses(): void {
    if (!report) {
      return;
    }
    const set = new Set<string>();
    for (const result of report.results) {
      if (result.status === "active" || result.status === "usage_not_limited") {
        set.add(result.status);
      }
    }
    setImportStatuses(Array.from(set).sort((a, b) => a.localeCompare(b)));
  }

  function ensureRepoConfig(): void {
    if (!repoUrl.trim()) {
      throw new Error("请填写 GitHub 仓库地址");
    }
    if (!githubToken.trim()) {
      throw new Error("请填写 GitHub Token");
    }
  }

  async function submitUploadCheck(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    setNotice("");
    if (archives.length === 0) {
      setError("请先上传至少一个 zip");
      return;
    }

    setIsCheckingUpload(true);
    try {
      const form = new FormData();
      for (const archive of archives) {
        form.append("archives", archive);
      }
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
      setNotice(`上传检查完成，共 ${payload.total} 条凭证。`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "检查失败";
      setError(message);
      setReport(null);
    } finally {
      setIsCheckingUpload(false);
    }
  }

  async function submitRepoCheck(): Promise<void> {
    setError("");
    setNotice("");
    setIsCheckingRepo(true);
    try {
      ensureRepoConfig();
      const response = await fetch("/api/github/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl,
          githubToken,
          branch: repoBranch,
          authSubdir: repoAuthSubdir,
          codexModel,
          timeoutSeconds,
          workers,
          codexUsageLimitOnly
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload?.error || "仓库检查失败"));
      }
      setReport(payload as CheckReport);
      setNotice(`仓库检查完成，共 ${payload.total} 条凭证。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "仓库检查失败");
      setReport(null);
    } finally {
      setIsCheckingRepo(false);
    }
  }

  async function downloadCleanedZip(): Promise<void> {
    if (!report || report.mode !== "upload") {
      setError("请先执行上传包检查");
      return;
    }
    if (archives.length === 0) {
      setError("当前没有可清理的上传包");
      return;
    }
    if (deleteStatuses.length === 0) {
      setError("先选择要删除的状态");
      return;
    }

    setError("");
    setNotice("");
    setIsCleaning(true);
    try {
      const form = new FormData();
      for (const archive of archives) {
        form.append("archives", archive);
      }
      form.append("deleteStatuses", deleteStatuses.join(","));
      form.append("providerScope", providerScope);
      form.append("resultRefs", JSON.stringify(toResultRefs(report)));

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
      anchor.download = `auths.cleaned.bundle.${Date.now()}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      const deletedCount = Number(response.headers.get("X-Deleted-Count") || 0);
      setNotice(`已生成清理包，删除 ${deletedCount} 个凭证文件。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "清理失败");
    } finally {
      setIsCleaning(false);
    }
  }

  async function importToGithubRepo(): Promise<void> {
    if (!report || report.mode !== "upload") {
      setError("请先执行上传包检查");
      return;
    }
    if (archives.length === 0) {
      setError("导入需要上传 zip");
      return;
    }
    if (importStatuses.length === 0) {
      setError("先选择导入状态（建议 active / usage_not_limited）");
      return;
    }

    setError("");
    setNotice("");
    setIsImportingRepo(true);
    try {
      ensureRepoConfig();
      const form = new FormData();
      for (const archive of archives) {
        form.append("archives", archive);
      }
      form.append("repoUrl", repoUrl);
      form.append("githubToken", githubToken);
      form.append("branch", repoBranch);
      form.append("authSubdir", repoAuthSubdir);
      form.append("importStatuses", importStatuses.join(","));
      form.append("providerScope", providerScope);
      form.append("resultRefs", JSON.stringify(toResultRefs(report)));

      const response = await fetch("/api/github/import", {
        method: "POST",
        body: form
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload?.error || "导入失败"));
      }
      const importedCount = Array.isArray(payload.imported_paths) ? payload.imported_paths.length : 0;
      const skippedCount = Array.isArray(payload.skipped_paths) ? payload.skipped_paths.length : 0;
      setNotice(`导入完成：成功 ${importedCount}，跳过 ${skippedCount}。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setIsImportingRepo(false);
    }
  }

  async function deleteFromGithubRepo(): Promise<void> {
    if (!report || report.mode !== "repo") {
      setError("请先执行仓库检查");
      return;
    }
    if (deleteStatuses.length === 0) {
      setError("先选择删除状态");
      return;
    }

    setError("");
    setNotice("");
    setIsDeletingRepo(true);
    try {
      ensureRepoConfig();
      const response = await fetch("/api/github/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl,
          githubToken,
          branch: repoBranch,
          authSubdir: repoAuthSubdir,
          deleteStatuses: deleteStatuses.join(","),
          providerScope,
          resultRefs: toResultRefs(report)
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload?.error || "删除失败"));
      }
      const deletedCount = Array.isArray(payload.deleted_paths) ? payload.deleted_paths.length : 0;
      const failedCount = Array.isArray(payload.failed_paths) ? payload.failed_paths.length : 0;
      setNotice(`仓库删除完成：成功 ${deletedCount}，失败 ${failedCount}。建议重新检查仓库确认。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setIsDeletingRepo(false);
    }
  }

  return (
    <main className="page-wrap">
      <div className="hero-backdrop" />

      <section className="panel hero">
        <p className="hero-label">2ApiCheck</p>
        <h1>多包检查 + GitHub 仓库管理</h1>
        <p>支持多 ZIP 上传检查、可用凭证一键导入仓库、仓库现有凭证状态检查与批量删除。</p>
      </section>

      <section className="panel">
        <h2>上传检查</h2>
        <form className="form-grid" onSubmit={submitUploadCheck}>
          <label className="field">
            <span>上传 ZIP（可多选）</span>
            <input
              type="file"
              accept=".zip,application/zip"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                setArchives(files);
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

          <button className="btn btn-main" type="submit" disabled={isCheckingUpload}>
            {isCheckingUpload ? "检查中..." : "检查上传包"}
          </button>
        </form>

        {archives.length > 0 ? (
          <p className="file-info">已选 {archives.length} 个文件：{archives.map((file) => file.name).join(", ")}</p>
        ) : null}
      </section>

      <section className="panel">
        <h2>GitHub 仓库</h2>
        <div className="form-grid">
          <label className="field">
            <span>Repo URL</span>
            <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/owner/repo" />
          </label>
          <label className="field">
            <span>Branch</span>
            <input value={repoBranch} onChange={(event) => setRepoBranch(event.target.value)} placeholder="master" />
          </label>
          <label className="field">
            <span>Auth Subdir</span>
            <input value={repoAuthSubdir} onChange={(event) => setRepoAuthSubdir(event.target.value)} placeholder="auths" />
          </label>
          <label className="field">
            <span>GitHub Token</span>
            <input type="password" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} placeholder="ghp_xxx" />
          </label>
          <button className="btn" type="button" onClick={submitRepoCheck} disabled={isCheckingRepo}>
            {isCheckingRepo ? "检查中..." : "检查仓库凭证"}
          </button>
        </div>
      </section>

      {error ? <p className="error-text">{error}</p> : null}
      {notice ? <p className="ok-text">{notice}</p> : null}

      {report ? (
        <>
          <section className="panel">
            <h2>检查结果</h2>
            <p>
              来源 {report.source_label}，总数 {report.total}，耗时 {report.duration_seconds}s，模式{" "}
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
            <h2>状态选择</h2>
            <div className="cleanup-row">
              <button className="btn" type="button" onClick={pickUnavailableCodexStatuses}>
                仅选不可用 Codex 状态
              </button>
              <button className="btn" type="button" onClick={pickImportableStatuses}>
                仅选可导入状态
              </button>
              <label className="scope-select">
                <span>范围</span>
                <select value={providerScope} onChange={(event) => setProviderScope(event.target.value as ProviderScope)}>
                  <option value="codex">只看 Codex</option>
                  <option value="all">全部 provider</option>
                </select>
              </label>
            </div>

            <p className="file-info">删除状态：</p>
            <div className="chip-wrap">
              {statusKeys.map((status) => (
                <label className="chip-option" key={`delete-${status}`}>
                  <input
                    type="checkbox"
                    checked={deleteStatuses.includes(status)}
                    onChange={() => setDeleteStatuses((prev) => toggleItem(prev, status))}
                  />
                  <span>{status}</span>
                </label>
              ))}
            </div>

            <p className="file-info">导入状态：</p>
            <div className="chip-wrap">
              {statusKeys.map((status) => (
                <label className="chip-option" key={`import-${status}`}>
                  <input
                    type="checkbox"
                    checked={importStatuses.includes(status)}
                    onChange={() => setImportStatuses((prev) => toggleItem(prev, status))}
                  />
                  <span>{status}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>操作</h2>
            <div className="cleanup-row">
              <button
                className="btn btn-danger"
                type="button"
                onClick={downloadCleanedZip}
                disabled={isCleaning || report.mode !== "upload"}
              >
                {isCleaning ? "打包中..." : "下载清理后 ZIP（上传包）"}
              </button>
              <button
                className="btn btn-main"
                type="button"
                onClick={importToGithubRepo}
                disabled={isImportingRepo || report.mode !== "upload"}
              >
                {isImportingRepo ? "导入中..." : "一键导入到 GitHub 仓库"}
              </button>
              <button
                className="btn btn-danger"
                type="button"
                onClick={deleteFromGithubRepo}
                disabled={isDeletingRepo || report.mode !== "repo"}
              >
                {isDeletingRepo ? "删除中..." : "删除仓库中选中状态凭证"}
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>明细（前 {TABLE_LIMIT} 条）</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>source</th>
                    <th>file</th>
                    <th>provider</th>
                    <th>status</th>
                    <th>http</th>
                    <th>reason</th>
                  </tr>
                </thead>
                <tbody>
                  {report.results.slice(0, TABLE_LIMIT).map((item) => (
                    <tr key={item.id}>
                      <td title={item.path}>{item.source}</td>
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
