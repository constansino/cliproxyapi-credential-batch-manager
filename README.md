# CLIProxyAPI Credential Batch Manager

`CLIProxyAPI Credential Batch Manager` is a standalone open-source CLI tool for:

- Batch scanning `auths/*.json` credentials used by CLIProxyAPI.
- Supporting both:
  - **Git repository mode** (clone credential repo with optional SSH key).
  - **Local folder mode** (directly scan server/local auth directory).
- Checking credential status across multiple providers (best-effort):
  - `codex`
  - `antigravity`
  - `gemini`
  - `gemini-cli`
  - unknown/other providers (offline expiry analysis fallback)
- Outputting detailed JSON report + terminal summary.
- One-click deleting expired/invalid/banned credentials locally or from git repo, with optional `git push`.

---

## Features

### 1) Multi-source input

- **Local mode**: `--auth-dir /path/to/auths`
- **Repo mode**: `--repo-url <git_url>` and optional `--git-key /path/to/id_ed25519`

### 2) Multi-provider checks

- **Codex** (`type: codex`): calls `https://chatgpt.com/backend-api/codex/responses` with token headers.
  - `401 + token_invalidated` => `invalidated`
  - deactivated messages => `deactivated`
  - `400` model errors still treated as token active
- **Google OAuth based** (`antigravity`, `gemini`, `gemini-cli`):
  - uses `https://oauth2.googleapis.com/tokeninfo?access_token=...`
- **Other providers**:
  - offline JWT/`expired` timestamp parsing fallback

### 3) Batch cleanup

- Delete by status class, for example:
  - `invalidated`
  - `expired_by_time`
  - `deactivated`
  - `unauthorized`
  - `missing_token`
- In repo mode, it can commit and push deletion changes.

---

## Quick Start

### Requirements

- Python 3.9+
- `git` (for repo mode)
- Network access for online validation endpoints

### Run in local auth folder mode

```bash
python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --report-file ./report.json
```

### Run in git repo mode (with SSH key)

```bash
python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --git-key ~/.ssh/id_ed25519 \
  --report-file ./report.json
```

### Delete invalid credentials (local mode)

```bash
python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --delete-statuses invalidated,expired_by_time,deactivated \
  --report-file ./report.json
```

### Delete + commit + push (repo mode)

```bash
python3 -m cliproxy_credman \
  --repo-url git@github.com:your-org/your-auth-repo.git \
  --git-key ~/.ssh/id_ed25519 \
  --delete-statuses invalidated,expired_by_time,deactivated \
  --git-commit \
  --git-push \
  --git-author-name "cred-bot" \
  --git-author-email "cred-bot@example.com"
```

---

## CLI Options

- `--auth-dir`: local auth directory containing `.json` files.
- `--repo-url`: git repo URL for auth repository.
- `--repo-branch`: branch (default: `master`).
- `--git-key`: SSH private key path for cloning/pushing private repos.
- `--workdir`: working directory for cloned repo (default: temp dir).
- `--auth-subdir`: subdirectory inside repo containing auth files (default: `auths`).
- `--timeout`: HTTP timeout seconds (default: `35`).
- `--workers`: concurrent workers (default: `16`).
- `--report-file`: save JSON report path.
- `--delete-statuses`: comma-separated statuses to delete.
- `--dry-run`: do not delete, only preview.
- `--git-commit`: create git commit after deletion.
- `--git-push`: push branch after commit.
- `--git-author-name`, `--git-author-email`: optional commit identity.

---

## Status Definitions (core)

- `active`: token appears usable.
- `invalidated`: token explicitly invalidated by provider.
- `deactivated`: account deactivated/disabled.
- `expired_by_time`: timestamp/JWT indicates token expired.
- `unauthorized`: unauthorized for unknown reason.
- `missing_token`: no usable access token found.
- `check_error`: request/check execution error.
- `unknown`: unable to conclude.

---

## Security Notes

- Tool never prints full token values.
- Keep reports protected: they may include file names/emails/provider error snippets.
- Use least-privilege git credentials.

---

## License

MIT

