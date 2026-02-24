# CPA Credential Batch Manager

用于批量检测与清理 CLIProxyAPI 凭证（`auths/*.json`）。

## 最常用（Linux/macOS）

先克隆：

```bash
git clone https://github.com/constansino/cliproxyapi-credential-batch-manager.git
cd cliproxyapi-credential-batch-manager
```

最常用命令（仓库模式 + `gpt-5` 测活 + 仅查 usage limit + 交互删除 + 自动提交推送）：

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo \
  --git-token "$GIT_TOKEN" \
  --workers 200 \
  --codex-model gpt-5 \
  --codex-usage-limit-only \
  --interactive \
  --git-commit \
  --git-push \
  --report-file ./report.json
```

## Windows PowerShell（单独说明）

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

## 常用场景

仅做 Codex usage-limit 检查（本地目录）：

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --workers 200 \
  --codex-model gpt-5 \
  --codex-usage-limit-only \
  --report-file ./usage_limit_report.json
```

非交互删除 usage-limited（仓库模式）：

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo \
  --git-token "$GIT_TOKEN" \
  --workers 200 \
  --codex-model gpt-5 \
  --codex-usage-limit-only \
  --delete-statuses usage_limited \
  --git-commit \
  --git-push \
  --report-file ./cleanup_report.json
```

菜单模式：

```bash
PYTHONPATH=src python3 -m cliproxy_credman --menu
```

## 交互界面操作

状态总览页：

- 输入序号：进入该状态详情
- `q`：退出

状态详情页：

- `空格+序号`：切换选中
- `a`：全选该状态
- `n`：清空选择
- `x`：删除选中并执行后续提交/推送
- `b`：返回

## 参数速查

数据源参数：

- `--repo-url` `--repo-branch` `--git-token` `--git-token-user`
- `--auth-dir`
- `--cpa-url` `--management-key`

执行参数：

- `--workers`（默认 `200`）
- `--timeout`（默认 `35` 秒）
- `--codex-model`（默认 `gpt-5`）
- `--codex-usage-limit-only`
- `--interactive`
- `--menu`
- `--schedule-minutes`

删除/推送参数：

- `--delete-statuses`
- `--dry-run`
- `--git-commit`
- `--git-push`

输出/通知参数：

- `--report-file`
- `--tg-bot-token`
- `--tg-chat-id`

## 状态说明

高频状态：

- `usage_limited`：返回 `The usage limit has been reached`
- `usage_not_limited`：仅在 `--codex-usage-limit-only` 下出现，表示可正常调用目标模型
- `active`：探测请求成功
- `invalidated` `deactivated` `unauthorized`
- `check_error` `unknown`
- `skipped_non_codex`：仅在 `--codex-usage-limit-only` 下出现

其他状态：

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
- `expired_by_time`
- `missing_token`

## 报告输出

报告关键字段：

- `mode`：`repo` / `cpa` / `local`
- `codex_model`
- `codex_usage_limit_only`
- `summary.by_status`
- `results[]`：`file`, `provider`, `status`, `http_status`, `reason`, `detail`
- `git.push_error`：推送失败时的详细错误

## 推送失败处理

大批量删除后 `git push` 失败时，脚本会自动进行多轮 fallback：

- 普通 `git push`
- `git push -u origin <branch>`
- `HTTP/1.1 + 大缓冲 + 降压缩` 推送

若仍失败，不会中断整轮检测；错误会写入 `report.git.push_error`。

## 安全建议

- 不要在终端截图或聊天中暴露 `GIT_TOKEN`
- 不要把 token 写进仓库
- 建议用环境变量传 token

```bash
export GIT_TOKEN='YOUR_GIT_TOKEN'
```

## License

MIT
