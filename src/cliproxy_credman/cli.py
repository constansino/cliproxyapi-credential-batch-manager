import argparse
import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class CheckResult:
    file: str
    path: str
    provider: str
    email: str
    status: str
    http_status: Optional[int]
    reason: str
    detail: str
    expired_field: str
    access_token_exp_utc: str
    checked_at_utc: str
    elapsed_ms: int


def utc_now_text() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CLIProxyAPI credential batch manager")
    parser.add_argument("--auth-dir", help="Local auth directory with JSON files")
    parser.add_argument("--repo-url", help="Git repository URL containing auth files")
    parser.add_argument("--repo-branch", default="master", help="Git branch to use")
    parser.add_argument("--git-key", help="SSH private key path")
    parser.add_argument("--workdir", help="Working directory for cloned repository")
    parser.add_argument("--auth-subdir", default="auths", help="Auth dir under repository")
    parser.add_argument("--timeout", type=int, default=35, help="HTTP timeout seconds")
    parser.add_argument("--workers", type=int, default=16, help="Concurrent workers")
    parser.add_argument("--report-file", default="./cliproxy_credman_report.json", help="Report JSON output path")
    parser.add_argument("--delete-statuses", default="", help="Comma-separated statuses to delete")
    parser.add_argument("--dry-run", action="store_true", help="Preview deletion only")
    parser.add_argument("--git-commit", action="store_true", help="Commit deletion changes in repo mode")
    parser.add_argument("--git-push", action="store_true", help="Push deletion changes in repo mode")
    parser.add_argument("--git-author-name", default="", help="Git commit author name")
    parser.add_argument("--git-author-email", default="", help="Git commit author email")
    return parser.parse_args()


def run_command(command: List[str], cwd: Optional[Path] = None, env: Optional[Dict[str, str]] = None) -> str:
    completed = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return completed.stdout.strip()


def build_git_env(git_key: Optional[str]) -> Dict[str, str]:
    environment = dict(os.environ)
    if git_key:
        key_path = str(Path(git_key).expanduser().resolve())
        environment["GIT_SSH_COMMAND"] = f"ssh -i {key_path} -o StrictHostKeyChecking=accept-new"
    return environment


def prepare_auth_dir(args: argparse.Namespace) -> Tuple[Path, bool, Optional[Path], Optional[Dict[str, str]]]:
    if bool(args.auth_dir) == bool(args.repo_url):
        raise ValueError("Provide exactly one of --auth-dir or --repo-url")

    if args.auth_dir:
        auth_dir = Path(args.auth_dir).expanduser().resolve()
        if not auth_dir.is_dir():
            raise ValueError(f"auth dir not found: {auth_dir}")
        return auth_dir, False, None, None

    git_env = build_git_env(args.git_key)
    if args.workdir:
        workdir = Path(args.workdir).expanduser().resolve()
        workdir.mkdir(parents=True, exist_ok=True)
        temporary = False
    else:
        workdir = Path(tempfile.mkdtemp(prefix="cliproxy_credman_"))
        temporary = True

    repo_dir = workdir / "repo"
    if repo_dir.exists():
        shutil.rmtree(repo_dir)

    run_command(
        [
            "git",
            "clone",
            "--single-branch",
            "--branch",
            args.repo_branch,
            args.repo_url,
            str(repo_dir),
        ],
        env=git_env,
    )

    auth_dir = repo_dir / args.auth_subdir
    if not auth_dir.is_dir():
        raise ValueError(f"auth subdir not found in repo: {auth_dir}")
    return auth_dir, temporary, repo_dir, git_env


def parse_iso_time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        normalized = text.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def parse_jwt_exp(token: Any) -> Optional[datetime]:
    if not isinstance(token, str) or token.count(".") != 2:
        return None
    payload = token.split(".")[1]
    padding = "=" * (-len(payload) % 4)
    try:
        raw = base64.urlsafe_b64decode((payload + padding).encode("utf-8"))
        data = json.loads(raw.decode("utf-8"))
        exp_value = data.get("exp")
        if isinstance(exp_value, int) and exp_value > 0:
            return datetime.fromtimestamp(exp_value, tz=timezone.utc)
    except Exception:
        return None
    return None


def format_datetime(value: Optional[datetime]) -> str:
    if value is None:
        return ""
    return value.strftime("%Y-%m-%d %H:%M:%S UTC")


def read_json_file(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def offline_expired(metadata: Dict[str, Any], now_utc: datetime) -> Tuple[bool, str, Optional[datetime]]:
    access_exp = parse_jwt_exp(metadata.get("access_token"))
    if access_exp is not None and access_exp <= now_utc:
        return True, "access_token jwt exp is in the past", access_exp

    expired_field = parse_iso_time(metadata.get("expired"))
    if expired_field is not None and expired_field <= now_utc:
        return True, "expired field is in the past", access_exp

    return False, "", access_exp


def http_json_request(url: str, method: str, headers: Dict[str, str], body: Optional[bytes], timeout_seconds: int) -> Tuple[int, str]:
    request = urllib.request.Request(url=url, data=body, method=method)
    for key, value in headers.items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            text = response.read().decode("utf-8", errors="ignore")
            return response.getcode(), text
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", errors="ignore")
        return err.code, text


def check_codex(metadata: Dict[str, Any], timeout_seconds: int) -> Tuple[str, int, str, str]:
    token = str(metadata.get("access_token") or "").strip()
    if not token:
        return "missing_token", 0, "access_token is missing", ""

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Openai-Beta": "responses=experimental",
        "Version": "0.98.0",
        "Originator": "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.98.0",
    }
    account_id = str(metadata.get("account_id") or "").strip()
    if account_id:
        headers["Chatgpt-Account-Id"] = account_id

    payload = {
        "model": "gpt-4.1-mini",
        "input": "ping",
        "stream": False,
    }

    status_code, response_text = http_json_request(
        url="https://chatgpt.com/backend-api/codex/responses",
        method="POST",
        headers=headers,
        body=json.dumps(payload).encode("utf-8"),
        timeout_seconds=timeout_seconds,
    )

    lower_text = response_text.lower()
    if status_code == 401 and ("token_invalidated" in lower_text or "authentication token has been invalidated" in lower_text):
        return "invalidated", status_code, "codex token invalidated", response_text
    if status_code == 401 and ("deactivated" in lower_text or "account has been deactivated" in lower_text):
        return "deactivated", status_code, "codex account deactivated", response_text
    if status_code == 401:
        return "unauthorized", status_code, "codex unauthorized", response_text
    if status_code in (200, 201, 400, 402, 403, 404, 409, 422, 429):
        return "active", status_code, "codex token appears usable", response_text
    return "unknown", status_code, "codex unexpected response", response_text


def check_google_oauth(metadata: Dict[str, Any], timeout_seconds: int) -> Tuple[str, int, str, str]:
    token = str(metadata.get("access_token") or "").strip()
    if not token:
        return "missing_token", 0, "access_token is missing", ""

    query = urllib.parse.urlencode({"access_token": token})
    status_code, response_text = http_json_request(
        url=f"https://oauth2.googleapis.com/tokeninfo?{query}",
        method="GET",
        headers={},
        body=None,
        timeout_seconds=timeout_seconds,
    )

    lower_text = response_text.lower()
    if status_code == 200:
        return "active", status_code, "google tokeninfo accepted token", response_text
    if status_code == 400 and ("invalid_token" in lower_text or "invalid" in lower_text):
        return "invalidated", status_code, "google token invalid", response_text
    if status_code == 401:
        return "unauthorized", status_code, "google token unauthorized", response_text
    return "unknown", status_code, "google tokeninfo unexpected response", response_text


def short_text(text: str, limit: int = 260) -> str:
    compact = " ".join((text or "").split())
    return compact[:limit]


def check_credential(path: Path, timeout_seconds: int) -> CheckResult:
    begin = time.time()
    now = datetime.now(timezone.utc)
    checked_at = utc_now_text()

    try:
        metadata = read_json_file(path)
    except Exception as error:
        elapsed = int((time.time() - begin) * 1000)
        return CheckResult(
            file=path.name,
            path=str(path),
            provider="unknown",
            email="",
            status="check_error",
            http_status=None,
            reason="invalid json",
            detail=short_text(repr(error)),
            expired_field="",
            access_token_exp_utc="",
            checked_at_utc=checked_at,
            elapsed_ms=elapsed,
        )

    provider = str(metadata.get("type") or "unknown").strip().lower() or "unknown"
    email = str(metadata.get("email") or "").strip()
    expired_text = str(metadata.get("expired") or "").strip()
    access_exp = parse_jwt_exp(metadata.get("access_token"))
    access_exp_text = format_datetime(access_exp)

    expired, expired_reason, _ = offline_expired(metadata, now)

    status = "unknown"
    http_status: Optional[int] = None
    reason = "no checker available"
    detail = ""

    try:
        if provider == "codex":
            status, code, reason, response_text = check_codex(metadata, timeout_seconds)
            http_status = code if code > 0 else None
            detail = short_text(response_text)
        elif provider in {"antigravity", "gemini", "gemini-cli"}:
            status, code, reason, response_text = check_google_oauth(metadata, timeout_seconds)
            http_status = code if code > 0 else None
            detail = short_text(response_text)
        else:
            if expired:
                status = "expired_by_time"
                reason = expired_reason
            else:
                status = "unknown"
                reason = "online checker not implemented for this provider"
    except Exception as error:
        status = "check_error"
        reason = "provider check failed"
        detail = short_text(repr(error))

    if status in {"unknown", "active"} and expired:
        status = "expired_by_time"
        reason = expired_reason

    elapsed = int((time.time() - begin) * 1000)
    return CheckResult(
        file=path.name,
        path=str(path),
        provider=provider,
        email=email,
        status=status,
        http_status=http_status,
        reason=reason,
        detail=detail,
        expired_field=expired_text,
        access_token_exp_utc=access_exp_text,
        checked_at_utc=checked_at,
        elapsed_ms=elapsed,
    )


def collect_auth_files(auth_dir: Path) -> List[Path]:
    return sorted(path for path in auth_dir.glob("*.json") if path.is_file())


def run_checks(auth_files: List[Path], workers: int, timeout_seconds: int) -> List[CheckResult]:
    results: List[CheckResult] = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [executor.submit(check_credential, auth_file, timeout_seconds) for auth_file in auth_files]
        for index, future in enumerate(as_completed(futures), start=1):
            results.append(future.result())
            if index % 50 == 0:
                print(f"progress: {index}/{len(auth_files)}")
    return sorted(results, key=lambda item: item.file)


def summarize(results: List[CheckResult]) -> Dict[str, Any]:
    by_status: Dict[str, int] = {}
    by_provider: Dict[str, int] = {}
    by_provider_status: Dict[str, Dict[str, int]] = {}

    for result in results:
        by_status[result.status] = by_status.get(result.status, 0) + 1
        by_provider[result.provider] = by_provider.get(result.provider, 0) + 1
        provider_bucket = by_provider_status.setdefault(result.provider, {})
        provider_bucket[result.status] = provider_bucket.get(result.status, 0) + 1

    return {
        "by_status": dict(sorted(by_status.items())),
        "by_provider": dict(sorted(by_provider.items())),
        "by_provider_status": {key: dict(sorted(value.items())) for key, value in sorted(by_provider_status.items())},
    }


def parse_delete_statuses(raw_value: str) -> List[str]:
    if not raw_value.strip():
        return []
    statuses = [part.strip() for part in raw_value.split(",")]
    return sorted({status for status in statuses if status})


def delete_credentials(results: List[CheckResult], delete_statuses: List[str], dry_run: bool) -> List[str]:
    target_paths = [result.path for result in results if result.status in delete_statuses]
    deleted: List[str] = []
    for path_text in target_paths:
        file_path = Path(path_text)
        if not file_path.exists():
            continue
        deleted.append(path_text)
        if not dry_run:
            file_path.unlink(missing_ok=True)
    return deleted


def git_commit_and_push(
    repo_dir: Path,
    git_env: Dict[str, str],
    do_commit: bool,
    do_push: bool,
    author_name: str,
    author_email: str,
    delete_statuses: List[str],
) -> Dict[str, Any]:
    outcome: Dict[str, Any] = {
        "committed": False,
        "pushed": False,
        "commit_id": "",
    }

    run_command(["git", "add", "-A"], cwd=repo_dir, env=git_env)
    status_text = run_command(["git", "status", "--porcelain"], cwd=repo_dir, env=git_env)
    if not status_text:
        return outcome

    if do_commit:
        commit_env = dict(git_env)
        if author_name:
            commit_env["GIT_AUTHOR_NAME"] = author_name
            commit_env["GIT_COMMITTER_NAME"] = author_name
        if author_email:
            commit_env["GIT_AUTHOR_EMAIL"] = author_email
            commit_env["GIT_COMMITTER_EMAIL"] = author_email

        message = f"cleanup auth credentials by status: {','.join(delete_statuses)}"
        run_command(["git", "commit", "-m", message], cwd=repo_dir, env=commit_env)
        commit_id = run_command(["git", "rev-parse", "HEAD"], cwd=repo_dir, env=git_env)
        outcome["committed"] = True
        outcome["commit_id"] = commit_id

        if do_push:
            run_command(["git", "push"], cwd=repo_dir, env=git_env)
            outcome["pushed"] = True

    return outcome


def print_summary(report: Dict[str, Any]) -> None:
    print("\n=== Summary ===")
    print(f"checked_at: {report['checked_at_utc']}")
    print(f"auth_dir: {report['auth_dir']}")
    print(f"total: {report['total']}")
    print("status counts:")
    for status, count in report["summary"]["by_status"].items():
        print(f"  - {status}: {count}")
    if report["deleted_files"]:
        print(f"deleted: {len(report['deleted_files'])}")


def main() -> None:
    args = parse_args()

    started_at = time.time()
    auth_dir: Path
    repo_mode = False
    temporary_workdir = False
    repo_dir: Optional[Path] = None
    git_env: Optional[Dict[str, str]] = None

    try:
        auth_dir, temporary_workdir, repo_dir, git_env = prepare_auth_dir(args)
        repo_mode = repo_dir is not None

        auth_files = collect_auth_files(auth_dir)
        if not auth_files:
            raise ValueError(f"no json files found under {auth_dir}")

        print(f"checking {len(auth_files)} credentials from: {auth_dir}")
        results = run_checks(auth_files, workers=args.workers, timeout_seconds=args.timeout)

        delete_statuses = parse_delete_statuses(args.delete_statuses)
        deleted_files: List[str] = []
        git_result: Dict[str, Any] = {"committed": False, "pushed": False, "commit_id": ""}

        if delete_statuses:
            deleted_files = delete_credentials(results, delete_statuses, dry_run=args.dry_run)
            if repo_mode and not args.dry_run and deleted_files:
                git_result = git_commit_and_push(
                    repo_dir=repo_dir,
                    git_env=git_env or dict(os.environ),
                    do_commit=args.git_commit,
                    do_push=args.git_push,
                    author_name=args.git_author_name,
                    author_email=args.git_author_email,
                    delete_statuses=delete_statuses,
                )

        report = {
            "checked_at_utc": utc_now_text(),
            "duration_seconds": round(time.time() - started_at, 3),
            "mode": "repo" if repo_mode else "local",
            "auth_dir": str(auth_dir),
            "total": len(results),
            "summary": summarize(results),
            "delete_statuses": delete_statuses,
            "dry_run": bool(args.dry_run),
            "deleted_files": deleted_files,
            "git": git_result,
            "results": [asdict(result) for result in results],
        }

        output_path = Path(args.report_file).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

        print_summary(report)
        print(f"report_file: {output_path}")

    finally:
        if temporary_workdir and repo_dir is not None:
            shutil.rmtree(repo_dir.parent, ignore_errors=True)


if __name__ == "__main__":
    main()

