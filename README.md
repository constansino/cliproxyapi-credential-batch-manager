# CPA Credential Batch Manager

用于批量检测与清理 CLIProxyAPI 凭证（`auths/*.json`）的开源命令行工具。

## 主要能力

- 批量检测凭证状态（多 provider）
- 检测后交互式选择要删除的凭证状态
- 可选 Telegram 推送摘要
- 可定时巡检（分钟级）

---

## 模式

### 1) Repository Mode（推荐）
管理 Git 仓库中的凭证文件（适合集中管理“云端凭证仓库”）。

- 输入：`--repo-url`（可选 `--git-token`）
- 输出：检测报告；可按状态删除并执行 `git commit` / `git push`

### 2) CPA API Mode
通过 CPA 管理接口远程管理服务器当前加载的凭证。

- 输入：`--cpa-url` + `--management-key`
- 输出：检测报告；可按状态调用 CPA 删除凭证

### 3) Local Directory Mode
直接扫描当前机器目录。

- 输入：`--auth-dir`

---

## 安装与运行

### 1. 克隆项目

```bash
git clone https://github.com/constansino/cliproxyapi-credential-batch-manager.git
cd cliproxyapi-credential-batch-manager
```

### 2. 直接运行（无需安装）

```bash
PYTHONPATH=src python3 -m cliproxy_credman --help
```

### 3. 可选：安装为命令

```bash
python3 -m pip install -e .
cliproxy-credman --help
```

---

## 交互式流程（推荐）

交互式流程会在检测后：
1. 输出状态统计
2. 让你输入要删除的状态（如 `invalidated,deactivated`）
3. 让你选择是否先 dry-run
4. 二次确认后执行删除

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --git-token YOUR_GIT_TOKEN \
  --interactive \
  --report-file ./repo_report.json
```

> 说明：`--interactive` 与 `--schedule-minutes` 不能同时使用。

### 菜单交互版（推荐给非命令行用户）

运行后会逐步提问：
- 选择模式（repo/cpa/local）
- 填写连接信息
- 选择是否启用 TG 推送
- 选择单次或定时
- 选择删除策略

```bash
PYTHONPATH=src python3 -m cliproxy_credman --menu
```

---

## Telegram 推送

检测结束后可推送摘要到 TG：

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --tg-bot-token 123456:ABCDEF_xxx \
  --tg-chat-id -1001234567890 \
  --report-file ./cpa_report.json
```

---

## 定时巡检

每 N 分钟执行一次检测（自动覆盖同一个 report 文件）：

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --git-token YOUR_GIT_TOKEN \
  --schedule-minutes 30 \
  --tg-bot-token 123456:ABCDEF_xxx \
  --tg-chat-id -1001234567890 \
  --report-file ./repo_report.json
```

停止方式：`Ctrl + C`

---

## 常见用法

### A. Repository Mode（主推）

#### 仅检测

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --repo-branch master \
  --report-file ./repo_report.json
```

#### 私有仓库（Git Token）

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --repo-branch master \
  --git-token YOUR_GIT_TOKEN \
  --report-file ./repo_report.json
```

可选：
- `--git-token-user`（默认 `x-access-token`）
- 或通过环境变量 `GIT_TOKEN` 提供 token

#### 非交互删除 + 推送

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --git-token YOUR_GIT_TOKEN \
  --delete-statuses invalidated,deactivated,expired_by_time,unauthorized \
  --git-commit \
  --git-push \
  --git-author-name "cred-bot" \
  --git-author-email "cred-bot@example.com" \
  --report-file ./repo_report.json
```

### B. CPA API Mode

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --report-file ./cpa_report.json
```

### C. Local Directory Mode

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --report-file ./local_report.json
```

---

## 检测状态

- `active`
- `invalidated`
- `deactivated`
- `expired_by_time`
- `unauthorized`
- `missing_token`
- `check_error`
- `unknown`

---

## 参数

- 输入模式：
  - `--repo-url` / `--repo-branch` / `--git-token` / `--git-token-user`
  - `--cpa-url` / `--management-key`
  - `--auth-dir`
- 执行控制：
  - `--interactive`
  - `--schedule-minutes`
  - `--workers`
  - `--timeout`
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

## 输出报告

JSON 报告关键字段：

- `mode`：`repo` / `cpa` / `local`
- `summary.by_status`
- `results[]`：`file`, `provider`, `status`, `http_status`, `reason`, `detail`

---

## 安全

- 不输出完整 token。
- 请勿提交报告文件或私钥。
- 使用最小权限密钥。

---

## License

MIT
