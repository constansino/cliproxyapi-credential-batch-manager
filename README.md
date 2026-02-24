# CPA Credential Batch Manager

用于批量检测与清理 CLIProxyAPI 凭证（`auths/*.json`）的开源命令行工具。

---

## 先直接用（推荐）

### 1) 克隆后立刻交互运行（云端 Git 凭证仓库）

```bash
git clone https://github.com/constansino/cliproxyapi-credential-batch-manager.git
cd cliproxyapi-credential-batch-manager

PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo \
  --git-token YOUR_GIT_TOKEN \
  --interactive \
  --report-file ./repo_report.json
```

### 2) 在上面基础上加 Telegram 推送

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo \
  --git-token YOUR_GIT_TOKEN \
  --interactive \
  --tg-bot-token YOUR_TG_BOT_TOKEN \
  --tg-chat-id YOUR_TG_CHAT_ID \
  --report-file ./repo_report.json
```

### 3) 在上面基础上改成定时巡检（每 30 分钟）

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo \
  --git-token YOUR_GIT_TOKEN \
  --schedule-minutes 30 \
  --tg-bot-token YOUR_TG_BOT_TOKEN \
  --tg-chat-id YOUR_TG_CHAT_ID \
  --report-file ./repo_report.json
```

> 说明：
> - `--interactive` 适合人工值守。
> - `--schedule-minutes` 适合自动巡检。
> - 两者不能同时使用。

---


## `--interactive` 实际交互行为

运行后会进入以下流程：

1. 先显示状态总览（`active / invalidated / deactivated / expired_by_time ...`）
2. 每个状态默认最多展示 10 条文件名，超过显示 `...`
3. 输入序号进入某个状态详情页，查看完整凭证名单（带复选框）
4. 在详情页可用：
   - `空格+序号`：切换某条凭证选中状态
   - `a`：全选此状态
   - `n`：取消全选
   - `x`：立即删除当前选中项（若未选中则删除此状态全部）
   - `b`：返回总览

说明：
- 详情页中的 `x` 会二次确认后执行。
- repo 模式删除后自动 `commit + push`，不再要求额外输入 git 用户名/邮箱。

---

## 菜单交互版（最省心）

不想记参数，直接走菜单：

```bash
PYTHONPATH=src python3 -m cliproxy_credman --menu
```

菜单会逐步让你选择：
- repo / cpa / local 模式
- 是否启用 TG
- 单次运行还是定时运行
- 删除策略（不删 / 交互删 / 固定状态删）

---

## 核心能力

- 批量检测凭证状态（多 provider）
- 检测后交互式选择删除范围
- TG 推送统计摘要
- 分钟级定时巡检
- 支持三种数据来源：
  - Repository Mode（推荐，管理云端 Git 凭证仓库）
  - CPA API Mode（远程管理 CPA 当前加载凭证）
  - Local Directory Mode（本机目录）

---

## 模式说明

### 1) Repository Mode（推荐）
管理 Git 仓库中的凭证文件（适合集中管理“云端凭证仓库”）。

- 输入：`--repo-url` + `--git-token`
- 输出：检测报告；可按状态删除并执行 `git commit` / `git push`

### 2) CPA API Mode
通过 CPA 管理接口远程管理服务器当前加载的凭证。

- 输入：`--cpa-url` + `--management-key`
- 输出：检测报告；可按状态调用 CPA 删除凭证

### 3) Local Directory Mode
直接扫描当前机器目录。

- 输入：`--auth-dir`

---

## 常见命令

### Repository Mode

#### 仅检测

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --git-token YOUR_GIT_TOKEN \
  --report-file ./repo_report.json
```

#### 非交互删除 + 推送

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --git-token YOUR_GIT_TOKEN \
  --codex-model gpt-5 \
  --delete-statuses invalidated,deactivated,expired_by_time,unauthorized \
  --git-commit \
  --git-push \
  --git-author-name "cred-bot" \
  --git-author-email "cred-bot@example.com" \
  --report-file ./repo_report.json
```

说明：大批量删除后 `git push` 失败时，脚本会自动做多轮 fallback（普通 push、`-u origin <branch>`、HTTP/1.1 + 大缓冲）。若仍失败，不会中断整轮检测，错误会写入 `report.git.push_error`。

### CPA API Mode

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --report-file ./cpa_report.json
```

### Local Directory Mode

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --report-file ./local_report.json
```

#### 仅做 Codex usage-limit 检查（筛选 `The usage limit has been reached`）

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --codex-model gpt-5 \
  --codex-usage-limit-only \
  --report-file ./usage_limit_report.json
```

### Windows PowerShell 用法（仓库模式 + 交互删除）

```powershell
Set-Location "C:\Users\1\Downloads\cliproxyapi-credential-batch-manager"
$env:PYTHONPATH = "src"

python -m cliproxy_credman `
  --repo-url "https://github.com/your-org/your-auth-repo" `
  --git-token "YOUR_GIT_TOKEN" `
  --workers 200 `
  --codex-model gpt-5 `
  --codex-usage-limit-only `
  --interactive `
  --git-commit `
  --git-push `
  --report-file ".\report.json"
```

---

## 参数

- 输入模式：
  - `--repo-url` / `--repo-branch` / `--git-token` / `--git-token-user`
  - `--cpa-url` / `--management-key`
  - `--auth-dir`
- 执行控制：
  - `--interactive`
  - `--schedule-minutes`
  - `--workers`（默认 `200`）
  - `--timeout`
  - `--codex-model`（默认 `gpt-5`）
  - `--codex-usage-limit-only`（仅检查 codex 的 usage limit，非 codex 直接跳过）
- 删除相关：
  - `--delete-statuses`
  - `--dry-run`
  - `--git-commit` / `--git-push`
- 通知：
  - `--tg-bot-token`
  - `--tg-chat-id`
- 输出：
  - `--report-file`

---

## 检测状态

- `active`
- `usage_limited`（例如 `error.type=usage_limit_reached`）
- `usage_not_limited`（仅在 `--codex-usage-limit-only` 下出现）
- `rate_limited`
- `model_unsupported`
- `probe_mismatch`
- `bad_request`
- `payment_required`
- `forbidden`
- `not_found`
- `conflict`
- `unprocessable`
- `server_error`
- `invalidated`
- `deactivated`
- `expired_by_time`
- `unauthorized`
- `missing_token`
- `check_error`
- `unknown`
- `skipped_non_codex`（仅在 `--codex-usage-limit-only` 下出现）

---

## 输出报告

JSON 报告关键字段：

- `mode`：`repo` / `cpa` / `local`
- `codex_model`
- `codex_usage_limit_only`
- `summary.by_status`
- `results[]`：`file`, `provider`, `status`, `http_status`, `reason`, `detail`

---

## 安全建议

- 不输出完整 token。
- 请勿把 `--git-token`、报告文件提交到仓库。
- 推荐使用环境变量 `GIT_TOKEN` 传递 token。

示例：

```bash
export GIT_TOKEN='YOUR_GIT_TOKEN'
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo \
  --interactive \
  --report-file ./repo_report.json
```

---

## License

MIT
