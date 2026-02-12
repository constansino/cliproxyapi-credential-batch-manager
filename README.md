# CPA 凭证批量管理工具

这是一个独立开源 CLI，用于批量管理 CLIProxyAPI（简称 CPA）的登录凭证。

核心目标：
- **本地凭证管理**：在运行 CPA 的服务器上直接执行。
- **云端凭证管理（重点）**：在任意机器执行，通过 CPA 管理接口远程批量检测/删除，**不需要 SSH**。

---

## 设计思路（按你的要求）

本工具优先复用 CPA 的核心管理能力：
- `GET /v0/management/auth-files` 获取凭证列表
- `POST /v0/management/api-call` 让 CPA 按 `auth_index` 代入 `$TOKEN$` 去实测上游
- `DELETE /v0/management/auth-files?name=...` 删除失效/封号凭证

所以“管理云端凭证”场景下，你只要能访问 CPA 端口和管理密钥即可，任何机器都能跑。

---

## 功能

- 支持三种模式：
  1. **CPA 在线模式（推荐）**：`--cpa-url --management-key`
  2. 本地目录模式：`--auth-dir`
  3. 仓库模式：`--repo-url`（可配 `--git-key`）
- 批量检测多 Provider（当前已覆盖）：
  - `codex`
  - `antigravity`
  - `gemini`
  - `gemini-cli`
  - 其他 provider（离线兜底）
- 输出统计 + JSON 报告
- 按状态一键删除
  - CPA 在线模式：直接删 CPA 里的凭证
  - 目录/仓库模式：删本地文件
  - 仓库模式可选 `git commit/push`

---

## 快速开始

### 1) 云端/远程 CPA（不需要 SSH）

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://你的CPA地址:8317 \
  --management-key 你的管理密码 \
  --workers 18 \
  --timeout 35 \
  --report-file ./cpa_report.json
```

### 2) 云端一键删除失效/封号

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://你的CPA地址:8317 \
  --management-key 你的管理密码 \
  --delete-statuses invalidated,deactivated,expired_by_time,unauthorized \
  --report-file ./cpa_report.json
```

先预览不删：

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://你的CPA地址:8317 \
  --management-key 你的管理密码 \
  --delete-statuses invalidated,deactivated \
  --dry-run \
  --report-file ./cpa_report.json
```

### 3) 本地目录模式

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --report-file ./local_report.json
```

### 4) 仓库模式

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --git-key ~/.ssh/id_ed25519 \
  --repo-branch master \
  --report-file ./repo_report.json
```

删除并推送：

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url git@github.com:your-org/your-auth-repo.git \
  --git-key ~/.ssh/id_ed25519 \
  --delete-statuses invalidated,deactivated,expired_by_time \
  --git-commit --git-push \
  --git-author-name "cred-bot" \
  --git-author-email "cred-bot@example.com"
```

---

## 状态说明

- `active`：凭证看起来可用
- `invalidated`：token 已失效/被作废
- `deactivated`：账号被停用/封禁
- `expired_by_time`：离线时间判断已过期
- `unauthorized`：401 但不属于 invalidated/deactivated
- `missing_token`：缺少 access_token
- `check_error`：检测过程中异常
- `unknown`：暂无法判定

---

## 参数

- `--cpa-url`：CPA 基础地址（如 `http://127.0.0.1:8317`）
- `--management-key`：CPA 管理密码/密钥
- `--auth-dir`：本地凭证目录
- `--repo-url`：凭证仓库地址
- `--repo-branch`：分支（默认 `master`）
- `--git-key`：Git SSH 私钥路径
- `--auth-subdir`：仓库内凭证目录（默认 `auths`）
- `--workers`：并发数（默认 `16`）
- `--timeout`：请求超时秒数（默认 `35`）
- `--report-file`：报告输出路径
- `--delete-statuses`：要删除的状态列表（逗号分隔）
- `--dry-run`：只预览不删除
- `--git-commit` / `--git-push`：仓库模式下提交/推送

---

## 安全建议

- 工具不会输出完整 token。
- 报告文件可能包含账号名和错误摘要，请妥善保存。
- 使用最小权限的管理密钥与 Git 凭证。

---

## License

MIT
