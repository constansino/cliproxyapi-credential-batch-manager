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
    parser.add_argument("--menu", action="store_true", help="Start interactive menu wizard")
    parser.add_argument("--cpa-url", help="CLIProxyAPI base url, e.g. http://127.0.0.1:8317")
    parser.add_argument("--management-key", help="CLIProxyAPI management password/key")
    parser.add_argument("--auth-dir", help="Local auth directory with JSON files")
    parser.add_argument("--repo-url", help="Git repository URL containing auth files")
    parser.add_argument("--repo-branch", default="master", help="Git branch to use")
    parser.add_argument("--git-token", default=os.getenv("GIT_TOKEN", ""), help="Git access token (or env GIT_TOKEN)")
    parser.add_argument("--git-token-user", default="x-access-token", help="Git token username for https URL")
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
    parser.add_argument("--interactive", action="store_true", help="Interactive mode: choose deletion after scan")
    parser.add_argument("--schedule-minutes", type=int, default=0, help="Run scan periodically every N minutes")
    parser.add_argument("--tg-bot-token", default="", help="Telegram bot token for notifications")
    parser.add_argument("--tg-chat-id", default="", help="Telegram chat id for notifications")
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


def build_git_env() -> Dict[str, str]:
    return dict(os.environ)


def build_repo_url_with_token(repo_url: str, git_token: str, token_user: str) -> str:
    repo_url = (repo_url or "").strip()
    token = (git_token or "").strip()
    user = (token_user or "x-access-token").strip()
    if not token:
        return repo_url
    if not repo_url.startswith("https://"):
        raise ValueError("--git-token currently requires https repo URL")

    parsed = urllib.parse.urlparse(repo_url)
    host = parsed.hostname or ""
    if not host:
        return repo_url
    port_part = f":{parsed.port}" if parsed.port else ""
    netloc = f"{user}:{urllib.parse.quote(token, safe='')}@{host}{port_part}"
    rebuilt = parsed._replace(netloc=netloc)
    return urllib.parse.urlunparse(rebuilt)


def prepare_auth_dir(args: argparse.Namespace) -> Tuple[Path, bool, Optional[Path], Optional[Dict[str, str]]]:
    if bool(args.auth_dir) == bool(args.repo_url):
        raise ValueError("Provide exactly one of --auth-dir or --repo-url")

    if args.auth_dir:
        auth_dir = Path(args.auth_dir).expanduser().resolve()
        if not auth_dir.is_dir():
            raise ValueError(f"auth dir not found: {auth_dir}")
        return auth_dir, False, None, None

    git_env = build_git_env()
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

    clone_repo_url = build_repo_url_with_token(args.repo_url, args.git_token, args.git_token_user)

    run_command(
        [
            "git",
            "clone",
            "--single-branch",
            "--branch",
            args.repo_branch,
            clone_repo_url,
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


def cpa_headers(management_key: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {management_key}",
        "Content-Type": "application/json",
    }


def cpa_fetch_auth_files(cpa_url: str, management_key: str, timeout_seconds: int) -> List[Dict[str, Any]]:
    base_url = cpa_url.rstrip("/")
    status_code, response_text = http_json_request(
        url=f"{base_url}/v0/management/auth-files",
        method="GET",
        headers={"Authorization": f"Bearer {management_key}"},
        body=None,
        timeout_seconds=timeout_seconds,
    )
    if status_code != 200:
        raise ValueError(f"failed to fetch auth-files: status={status_code}, body={short_text(response_text, 600)}")
    payload = json.loads(response_text)
    files = payload.get("files")
    if not isinstance(files, list):
        raise ValueError("invalid /auth-files response: missing files[]")
    return files


def cpa_api_call(cpa_url: str, management_key: str, payload: Dict[str, Any], timeout_seconds: int) -> Tuple[int, str]:
    base_url = cpa_url.rstrip("/")
    status_code, response_text = http_json_request(
        url=f"{base_url}/v0/management/api-call",
        method="POST",
        headers=cpa_headers(management_key),
        body=json.dumps(payload).encode("utf-8"),
        timeout_seconds=timeout_seconds,
    )
    if status_code != 200:
        return status_code, response_text
    try:
        envelope = json.loads(response_text)
        upstream_code = int(envelope.get("status_code", 0))
        upstream_body = str(envelope.get("body") or "")
        return upstream_code, upstream_body
    except Exception:
        return 0, response_text


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


def classify_codex_response(status_code: int, response_text: str) -> Tuple[str, str]:
    lower_text = response_text.lower()
    if status_code == 401 and ("token_invalidated" in lower_text or "authentication token has been invalidated" in lower_text):
        return "invalidated", "codex token invalidated"
    if status_code == 401 and ("deactivated" in lower_text or "account has been deactivated" in lower_text):
        return "deactivated", "codex account deactivated"
    if status_code == 401:
        return "unauthorized", "codex unauthorized"
    if status_code in (200, 201, 400, 402, 403, 404, 409, 422, 429):
        return "active", "codex token appears usable"
    return "unknown", "codex unexpected response"


def classify_google_response(status_code: int, response_text: str) -> Tuple[str, str]:
    lower_text = response_text.lower()
    if status_code == 200:
        return "active", "google oauth token appears usable"
    if status_code == 401 and ("invalid" in lower_text or "unauthorized" in lower_text):
        return "invalidated", "google oauth token invalid"
    if status_code == 403:
        return "active", "google oauth token active but scope may be limited"
    if status_code == 401:
        return "unauthorized", "google oauth unauthorized"
    return "unknown", "google oauth unexpected response"


def cpa_check_entry(cpa_url: str, management_key: str, entry: Dict[str, Any], timeout_seconds: int) -> CheckResult:
    begin = time.time()
    checked_at = utc_now_text()

    name = str(entry.get("name") or entry.get("id") or "")
    provider = str(entry.get("provider") or entry.get("type") or "unknown").strip().lower() or "unknown"
    email = str(entry.get("email") or "")
    auth_index = str(entry.get("auth_index") or "")

    if not auth_index:
        elapsed = int((time.time() - begin) * 1000)
        return CheckResult(
            file=name,
            path="",
            provider=provider,
            email=email,
            status="unknown",
            http_status=None,
            reason="missing auth_index from CPA auth-files",
            detail="",
            expired_field="",
            access_token_exp_utc="",
            checked_at_utc=checked_at,
            elapsed_ms=elapsed,
        )

    try:
        if provider == "codex":
            payload = {
                "auth_index": auth_index,
                "method": "POST",
                "url": "https://chatgpt.com/backend-api/codex/responses",
                "header": {
                    "Authorization": "Bearer $TOKEN$",
                    "Content-Type": "application/json",
                    "Openai-Beta": "responses=experimental",
                    "Version": "0.98.0",
                    "Originator": "codex_cli_rs",
                    "User-Agent": "codex_cli_rs/0.98.0",
                },
                "data": json.dumps({"model": "gpt-4.1-mini", "input": "ping", "stream": False}),
            }
            code, body = cpa_api_call(cpa_url, management_key, payload, timeout_seconds)
            status, reason = classify_codex_response(code, body)
        elif provider in {"antigravity", "gemini", "gemini-cli"}:
            payload = {
                "auth_index": auth_index,
                "method": "GET",
                "url": "https://www.googleapis.com/oauth2/v3/userinfo",
                "header": {
                    "Authorization": "Bearer $TOKEN$",
                    "User-Agent": "cliproxy-credman/0.1",
                },
            }
            code, body = cpa_api_call(cpa_url, management_key, payload, timeout_seconds)
            status, reason = classify_google_response(code, body)
        else:
            code = None
            body = ""
            status = "unknown"
            reason = "unsupported provider in CPA online mode"
    except Exception as error:
        code = None
        body = repr(error)
        status = "check_error"
        reason = "cpa api-call failed"

    elapsed = int((time.time() - begin) * 1000)
    return CheckResult(
        file=name,
        path="",
        provider=provider,
        email=email,
        status=status,
        http_status=code,
        reason=reason,
        detail=short_text(body),
        expired_field="",
        access_token_exp_utc="",
        checked_at_utc=checked_at,
        elapsed_ms=elapsed,
    )


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


def run_checks_cpa(cpa_url: str, management_key: str, entries: List[Dict[str, Any]], workers: int, timeout_seconds: int) -> List[CheckResult]:
    results: List[CheckResult] = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [
            executor.submit(cpa_check_entry, cpa_url, management_key, entry, timeout_seconds)
            for entry in entries
        ]
        for index, future in enumerate(as_completed(futures), start=1):
            results.append(future.result())
            if index % 50 == 0:
                print(f"progress: {index}/{len(entries)}")
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


def delete_credentials_cpa(
    cpa_url: str,
    management_key: str,
    results: List[CheckResult],
    delete_statuses: List[str],
    dry_run: bool,
    timeout_seconds: int,
) -> List[str]:
    targets = [result.file for result in results if result.status in delete_statuses and result.file]
    deleted: List[str] = []
    for name in targets:
        deleted.append(name)
        if dry_run:
            continue
        url = f"{cpa_url.rstrip('/')}/v0/management/auth-files?{urllib.parse.urlencode({'name': name})}"
        code, body = http_json_request(
            url=url,
            method="DELETE",
            headers={"Authorization": f"Bearer {management_key}"},
            body=None,
            timeout_seconds=timeout_seconds,
        )
        if code != 200:
            print(f"delete failed: {name}, status={code}, body={short_text(body, 200)}")
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
    print(f"mode: {report.get('mode', '')}")
    if report.get("mode") == "cpa":
        print(f"cpa_url: {report.get('cpa_url', '')}")
    else:
        print(f"auth_dir: {report['auth_dir']}")
    print(f"total: {report['total']}")
    print("status counts:")
    for status, count in report["summary"]["by_status"].items():
        print(f"  - {status}: {count}")
    if report["deleted_files"]:
        print(f"deleted: {len(report['deleted_files'])}")


def prompt_yes_no(question: str, default_no: bool = True) -> bool:
    suffix = "[y/N]" if default_no else "[Y/n]"
    raw = input(f"{question} {suffix}: ").strip().lower()
    if not raw:
        return not default_no
    return raw in {"y", "yes"}


def prompt_input(question: str, default_value: str = "") -> str:
    suffix = f" [{default_value}]" if default_value else ""
    raw = input(f"{question}{suffix}: ").strip()
    return raw if raw else default_value


def prompt_choice(question: str, options: List[Tuple[str, str]], default_key: str) -> str:
    print(f"\n{question}")
    for key, label in options:
        print(f"  {key}) {label}")
    while True:
        selected = prompt_input("请选择", default_key)
        keys = {key for key, _ in options}
        if selected in keys:
            return selected
        print("输入无效，请重试。")


def apply_menu_configuration(args: argparse.Namespace) -> argparse.Namespace:
    print("\n=== CPA Credential Batch Manager 菜单向导 ===")

    mode = prompt_choice(
        "选择数据来源模式",
        [
            ("1", "Repository Mode（云端 Git 仓库凭证）"),
            ("2", "CPA API Mode（远程 CPA 本地凭证）"),
            ("3", "Local Directory Mode（本机目录）"),
        ],
        "1",
    )

    args.cpa_url = None
    args.management_key = None
    args.repo_url = None
    args.auth_dir = None

    if mode == "1":
        args.repo_url = prompt_input("输入 repo URL（https）")
        args.repo_branch = prompt_input("输入分支", args.repo_branch or "master")
        args.git_token = prompt_input("输入 Git Token（私有仓库建议填写）", args.git_token or "")
        args.git_token_user = prompt_input("Git Token 用户名", args.git_token_user or "x-access-token")
        args.auth_subdir = prompt_input("仓库内凭证目录", args.auth_subdir or "auths")
    elif mode == "2":
        args.cpa_url = prompt_input("输入 CPA URL（例如 http://127.0.0.1:8317）")
        args.management_key = prompt_input("输入 CPA management key")
    else:
        args.auth_dir = prompt_input("输入本地 auth 目录路径")

    args.workers = int(prompt_input("并发 workers", str(args.workers)))
    args.timeout = int(prompt_input("请求超时秒数", str(args.timeout)))
    args.report_file = prompt_input("报告输出文件", args.report_file)

    enable_tg = prompt_yes_no("是否启用 Telegram 推送？", default_no=True)
    if enable_tg:
        args.tg_bot_token = prompt_input("TG Bot Token")
        args.tg_chat_id = prompt_input("TG Chat ID")
    else:
        args.tg_bot_token = ""
        args.tg_chat_id = ""

    schedule_choice = prompt_choice(
        "运行方式",
        [
            ("1", "单次运行"),
            ("2", "定时运行"),
        ],
        "1",
    )
    if schedule_choice == "2":
        args.schedule_minutes = int(prompt_input("定时间隔（分钟）", "30"))
    else:
        args.schedule_minutes = 0

    delete_mode = prompt_choice(
        "删除策略",
        [
            ("1", "不删除，只检测"),
            ("2", "检测后交互选择删除状态"),
            ("3", "固定状态自动删除/预演"),
        ],
        "2",
    )

    args.delete_statuses = ""
    args.dry_run = False
    args.interactive = False

    if delete_mode == "2":
        if args.schedule_minutes > 0:
            print("定时模式不支持交互删除，已切换为固定状态 dry-run。")
            args.delete_statuses = "invalidated,deactivated,expired_by_time,unauthorized"
            args.dry_run = True
        else:
            args.interactive = True
    elif delete_mode == "3":
        args.delete_statuses = prompt_input(
            "输入要处理的状态（逗号分隔）",
            "invalidated,deactivated,expired_by_time,unauthorized",
        )
        args.dry_run = prompt_yes_no("是否 dry-run（只预演不删除）？", default_no=False)

    if mode == "1" and args.delete_statuses and not args.dry_run:
        args.git_commit = prompt_yes_no("删除后是否 git commit？", default_no=False)
        args.git_push = prompt_yes_no("删除后是否 git push？", default_no=False)
        if args.git_commit:
            args.git_author_name = prompt_input("git author name", args.git_author_name or "cred-bot")
            args.git_author_email = prompt_input("git author email", args.git_author_email or "cred-bot@example.com")

    print("\n菜单配置完成，开始执行...\n")
    return args


def interactive_delete_statuses(results: List[CheckResult]) -> Tuple[List[str], bool]:
    status_counts = summarize(results).get("by_status", {})
    print("\n可删除状态候选:")
    for status, count in status_counts.items():
        print(f"  - {status}: {count}")

    suggested = [status for status in ["invalidated", "deactivated", "expired_by_time", "unauthorized"] if status_counts.get(status, 0) > 0]
    default_text = ",".join(suggested)
    raw = input(f"\n输入要删除的状态（逗号分隔，直接回车=不删除）[{default_text}]: ").strip()
    selected_text = raw or default_text
    statuses = parse_delete_statuses(selected_text)
    if not statuses:
        return [], True

    dry_run = prompt_yes_no("先 dry-run 预演删除吗？", default_no=False)
    return statuses, dry_run


def group_results_by_status(results: List[CheckResult]) -> Dict[str, List[CheckResult]]:
    grouped: Dict[str, List[CheckResult]] = {}
    for result in results:
        grouped.setdefault(result.status, []).append(result)
    for status in grouped:
        grouped[status] = sorted(grouped[status], key=lambda item: item.file)
    return grouped


def print_status_overview(results: List[CheckResult], selected_statuses: List[str]) -> List[str]:
    grouped = group_results_by_status(results)
    ordered = sorted(grouped.keys(), key=lambda key: (-len(grouped[key]), key))
    selected = set(selected_statuses)

    print("\n=== 状态总览（每类最多展示 10 条）===")
    for index, status in enumerate(ordered, start=1):
        items = grouped[status]
        marker = "*" if status in selected else " "
        print(f"{index:>2}. [{marker}] {status} ({len(items)})")
        sample = items[:10]
        for item in sample:
            print(f"    - {item.file}")
        if len(items) > 10:
            print("    ...")
    return ordered


def interactive_status_picker(results: List[CheckResult]) -> List[str]:
    grouped = group_results_by_status(results)
    selected: List[str] = []

    while True:
        ordered = print_status_overview(results, selected)
        print("\n操作：输入序号查看详情；x=执行删除流程；q=不删除并退出")
        command = input("请输入: ").strip().lower()
        if command == "q":
            return []
        if command == "x":
            return selected
        if not command.isdigit():
            print("输入无效，请输入序号/x/q。")
            continue

        position = int(command)
        if position < 1 or position > len(ordered):
            print("序号超出范围。")
            continue

        status = ordered[position - 1]
        items = grouped[status]
        print(f"\n--- 详情：{status} ({len(items)}) ---")
        for item in items:
            code_text = str(item.http_status) if item.http_status is not None else "-"
            print(f"- {item.file} | http={code_text} | {item.reason}")
        print("\n按键：d=切换选择删除该状态，b=返回")
        detail_action = input("请输入: ").strip().lower()
        if detail_action == "d":
            if status in selected:
                selected = [value for value in selected if value != status]
                print(f"已取消：{status}")
            else:
                selected.append(status)
                print(f"已加入删除：{status}")


def interactive_delete_plan(results: List[CheckResult]) -> Tuple[List[str], str]:
    statuses = interactive_status_picker(results)
    if not statuses:
        return [], "none"

    print("\n删除执行方式：")
    print("  1) 仅 dry-run 预演")
    print("  2) 直接真删")
    print("  3) 先 dry-run，再确认真删")
    print("  4) 取消")
    while True:
        command = input("请选择 [1/2/3/4]: ").strip()
        if command == "1":
            return statuses, "dry"
        if command == "2":
            return statuses, "apply"
        if command == "3":
            return statuses, "dry_then_apply"
        if command == "4":
            return [], "none"
        print("输入无效，请重试。")


def telegram_text(report: Dict[str, Any]) -> str:
    mode = report.get("mode", "")
    total = report.get("total", 0)
    summary = report.get("summary", {}).get("by_status", {})
    lines = [
        "[CPA Credential Batch Manager]",
        f"Time: {report.get('checked_at_utc', '')}",
        f"Mode: {mode}",
        f"Total: {total}",
        "Status:",
    ]
    for key, value in summary.items():
        lines.append(f"- {key}: {value}")
    deleted_count = len(report.get("deleted_files", []))
    if deleted_count:
        lines.append(f"Deleted: {deleted_count}")
    return "\n".join(lines)


def send_telegram(bot_token: str, chat_id: str, text: str, timeout_seconds: int) -> None:
    payload = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8")
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    code, body = http_json_request(
        url=url,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=payload,
        timeout_seconds=timeout_seconds,
    )
    if code != 200:
        print(f"telegram push failed: status={code}, body={short_text(body, 200)}")


def run_once(args: argparse.Namespace) -> Dict[str, Any]:
    started_at = time.time()
    auth_dir: Path
    repo_mode = False
    temporary_workdir = False
    repo_dir: Optional[Path] = None
    git_env: Optional[Dict[str, str]] = None

    try:
        cpa_mode = bool(args.cpa_url)
        if cpa_mode:
            if not args.management_key:
                raise ValueError("--management-key is required when --cpa-url is provided")
            entries = cpa_fetch_auth_files(args.cpa_url, args.management_key, args.timeout)
            if not entries:
                raise ValueError("no credentials returned by CPA /v0/management/auth-files")
            print(f"checking {len(entries)} credentials from CPA: {args.cpa_url}")
            results = run_checks_cpa(args.cpa_url, args.management_key, entries, workers=args.workers, timeout_seconds=args.timeout)
            auth_dir = Path("")
            repo_mode = False
        else:
            auth_dir, temporary_workdir, repo_dir, git_env = prepare_auth_dir(args)
            repo_mode = repo_dir is not None
            auth_files = collect_auth_files(auth_dir)
            if not auth_files:
                raise ValueError(f"no json files found under {auth_dir}")
            print(f"checking {len(auth_files)} credentials from: {auth_dir}")
            results = run_checks(auth_files, workers=args.workers, timeout_seconds=args.timeout)

        delete_statuses = parse_delete_statuses(args.delete_statuses)
        run_dry_run = bool(args.dry_run)
        interactive_mode = "none"
        if args.interactive:
            chosen_statuses, mode = interactive_delete_plan(results)
            delete_statuses = chosen_statuses
            interactive_mode = mode
            if mode == "dry":
                run_dry_run = True
            elif mode == "apply":
                run_dry_run = False
            elif mode == "dry_then_apply":
                run_dry_run = False
            else:
                run_dry_run = True

        deleted_files: List[str] = []
        git_result: Dict[str, Any] = {"committed": False, "pushed": False, "commit_id": ""}

        if delete_statuses:
            preview_targets = sorted([item.file for item in results if item.status in delete_statuses])
            if interactive_mode in {"dry", "dry_then_apply"}:
                print(f"\ndry-run 预演将影响 {len(preview_targets)} 个凭证")
                for name in preview_targets[:20]:
                    print(f"- {name}")
                if len(preview_targets) > 20:
                    print("...")

            if args.interactive and not prompt_yes_no("确认执行当前删除动作？", default_no=True):
                print("已取消删除。")
            else:
                if interactive_mode == "dry_then_apply":
                    _ = delete_credentials_cpa(
                        cpa_url=args.cpa_url,
                        management_key=args.management_key,
                        results=results,
                        delete_statuses=delete_statuses,
                        dry_run=True,
                        timeout_seconds=args.timeout,
                    ) if cpa_mode else delete_credentials(results, delete_statuses, dry_run=True)
                    if not prompt_yes_no("dry-run 完成，是否执行真删？", default_no=True):
                        print("已跳过真删。")
                    else:
                        if cpa_mode:
                            deleted_files = delete_credentials_cpa(
                                cpa_url=args.cpa_url,
                                management_key=args.management_key,
                                results=results,
                                delete_statuses=delete_statuses,
                                dry_run=False,
                                timeout_seconds=args.timeout,
                            )
                        else:
                            deleted_files = delete_credentials(results, delete_statuses, dry_run=False)
                        run_dry_run = False
                else:
                    if cpa_mode:
                        deleted_files = delete_credentials_cpa(
                            cpa_url=args.cpa_url,
                            management_key=args.management_key,
                            results=results,
                            delete_statuses=delete_statuses,
                            dry_run=run_dry_run,
                            timeout_seconds=args.timeout,
                        )
                    else:
                        deleted_files = delete_credentials(results, delete_statuses, dry_run=run_dry_run)

                if repo_mode and not run_dry_run and deleted_files:
                    if args.interactive:
                        args.git_commit = prompt_yes_no("repo 已删除，是否 git commit？", default_no=False)
                        args.git_push = args.git_commit and prompt_yes_no("是否 git push？", default_no=False)
                        if args.git_commit:
                            args.git_author_name = prompt_input("git author name", args.git_author_name or "cred-bot")
                            args.git_author_email = prompt_input("git author email", args.git_author_email or "cred-bot@example.com")
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
            "mode": "cpa" if cpa_mode else ("repo" if repo_mode else "local"),
            "cpa_url": args.cpa_url or "",
            "auth_dir": str(auth_dir) if not cpa_mode else "",
            "total": len(results),
            "summary": summarize(results),
            "delete_statuses": delete_statuses,
            "dry_run": run_dry_run,
            "deleted_files": deleted_files,
            "git": git_result,
            "results": [asdict(result) for result in results],
        }
        return report
    finally:
        if temporary_workdir and repo_dir is not None:
            shutil.rmtree(repo_dir.parent, ignore_errors=True)


def main() -> None:
    args = parse_args()

    if args.menu:
        args = apply_menu_configuration(args)

    if args.schedule_minutes < 0:
        raise ValueError("--schedule-minutes must be >= 0")
    if args.schedule_minutes > 0 and args.interactive:
        raise ValueError("--interactive cannot be used with --schedule-minutes")

    report_path = Path(args.report_file).expanduser().resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)

    iteration = 0
    while True:
        iteration += 1
        if iteration > 1:
            sleep_seconds = args.schedule_minutes * 60
            print(f"\nnext run in {args.schedule_minutes} minute(s)...")
            time.sleep(sleep_seconds)

        report = run_once(args)
        report["iteration"] = iteration
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

        print_summary(report)
        print(f"report_file: {report_path}")

        if args.tg_bot_token and args.tg_chat_id:
            send_telegram(args.tg_bot_token, args.tg_chat_id, telegram_text(report), args.timeout)

        if args.schedule_minutes <= 0:
            break


if __name__ == "__main__":
    main()
