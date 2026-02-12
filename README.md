# CPA 凭证批量管理工具（CLIProxyAPI Credential Batch Manager）

一个专门用于 **CLIProxyAPI 凭证批量检测与清理** 的开源 CLI 工具。

---

## 先说明：两种“云端”不是一回事

很多人会混淆，这里先讲清楚：

### A. 云端 **Git 仓库凭证**（你说的主推场景）
- 凭证保存在 GitHub/GitLab 仓库（例如 `auths/*.json`）
- 你希望在任意机器拉取仓库后批量检测，然后删除失效凭证并提交推送
- 对应本工具模式：`--repo-url`（可配 `--git-key`）

### B. 云端服务器上 CPA 的 **本地凭证目录**
- 凭证在服务器上 CPA 本地目录（例如容器内/挂载目录）
- 你不想 SSH，只想通过 CPA 管理接口远程检测/删除
- 对应本工具模式：`--cpa-url --management-key`

> 结论：
> - 管理 **Git 仓库凭证**：优先用 `--repo-url`
> - 管理 **远程服务器本地凭证**：用 `--cpa-url`

---

## 功能概览

- 支持三种输入模式：
  1. `--repo-url`（主推：云端 Git 仓库凭证）
  2. `--cpa-url`（远程 CPA 本地凭证）
  3. `--auth-dir`（当前机器本地目录）
- 批量检测 provider（当前已覆盖）：
  - `codex`
  - `antigravity`
  - `gemini`
  - `gemini-cli`
  - 其他 provider 提供离线兜底判定
- 输出统计和完整 JSON 报告
- 支持按状态一键删除
  - repo 模式：删文件后可 `git commit` + `git push`
  - cpa 模式：调用 CPA 管理接口直接删除
  - auth-dir 模式：删除本地文件

---

## 环境要求

- Python 3.9+
- Git（仅 repo 模式需要）
- 能访问目标网络（OpenAI/Google/CPA 接口）

---

## 从零开始：别人拿到仓库怎么用

### 1) 克隆本项目

```bash
git clone https://github.com/constansino/cliproxyapi-credential-batch-manager.git
cd cliproxyapi-credential-batch-manager
```

### 2) 最简单运行方式（无需安装）

```bash
PYTHONPATH=src python3 -m cliproxy_credman --help
```

### 3) 可选：安装为命令

```bash
python3 -m pip install -e .
cliproxy-credman --help
```

---

## 场景 1（主推）：管理云端 Git 仓库凭证

### 1. 只检测，不删除

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --repo-branch master \
  --report-file ./repo_report.json
```

如果是私有仓库，用 SSH key：

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url git@github.com:your-org/your-auth-repo.git \
  --repo-branch master \
  --git-key ~/.ssh/id_ed25519 \
  --report-file ./repo_report.json
```

### 2. 删除失效并自动提交推送

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url git@github.com:your-org/your-auth-repo.git \
  --repo-branch master \
  --git-key ~/.ssh/id_ed25519 \
  --delete-statuses invalidated,deactivated,expired_by_time,unauthorized \
  --git-commit \
  --git-push \
  --git-author-name "cred-bot" \
  --git-author-email "cred-bot@example.com" \
  --report-file ./repo_report.json
```

### 3. 先预演（不删）

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url git@github.com:your-org/your-auth-repo.git \
  --git-key ~/.ssh/id_ed25519 \
  --delete-statuses invalidated,deactivated \
  --dry-run \
  --report-file ./repo_report_preview.json
```

---

## 场景 2：管理远程服务器 CPA 本地凭证（不 SSH）

> 注意：这个场景不是管理 Git 仓库，而是管理服务器 CPA 当前加载的本地凭证。

### 1. 检测

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --report-file ./cpa_report.json
```

### 2. 删除（先 dry-run）

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --delete-statuses invalidated,deactivated \
  --dry-run \
  --report-file ./cpa_report_preview.json
```

### 3. 真删

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --delete-statuses invalidated,deactivated \
  --report-file ./cpa_report.json
```

---

## 场景 3：本地目录模式

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --report-file ./local_report.json
```

---

## 关键参数说明

- `--repo-url`：凭证仓库地址（主推场景）
- `--repo-branch`：分支名（默认 `master`）
- `--git-key`：私有仓库 SSH key
- `--cpa-url`：CPA 服务地址（例如 `http://127.0.0.1:8317`）
- `--management-key`：CPA 管理密钥
- `--auth-dir`：本地 auth 目录
- `--workers`：并发数（默认 16）
- `--timeout`：请求超时秒数（默认 35）
- `--delete-statuses`：要删除的状态，逗号分隔
- `--dry-run`：只预演，不删除
- `--git-commit` / `--git-push`：repo 模式提交推送
- `--report-file`：报告输出路径

---

## 状态定义

- `active`：凭证可用（或至少未被判定失效）
- `invalidated`：token 已失效/被作废
- `deactivated`：账号被停用
- `expired_by_time`：离线时间字段/JWT 判定过期
- `unauthorized`：401 但非 invalidated/deactivated
- `missing_token`：缺失 token
- `check_error`：检测过程异常
- `unknown`：暂无法判断

---

## 报告格式

报告为 JSON，核心字段：

- `mode`: `repo` / `cpa` / `local`
- `summary.by_status`: 各状态统计
- `results[]`:
  - `file`
  - `provider`
  - `status`
  - `http_status`
  - `reason`
  - `detail`

---

## 安全建议

- 本工具不会打印完整 token。
- 报告含账号文件名和错误摘要，请妥善保管。
- 使用最小权限 Git key / 管理密钥。
- 不要把报告或私钥提交到工具仓库。

---

## License

MIT
