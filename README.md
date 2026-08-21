# Herdr Title Distill

Herdr 跨 harness 智能标题服务。它在每个已完成主回合后读取 transcript，用 OMP 的标题模型只提炼当前目标，并把 2–10 个可见字符同步到 Herdr pane；单-pane tab 跟随，multi-pane tab 和手工名称受保护。

支持 OMP、Pi、Claude Code、Codex、Grok、Copilot、Hermes。未知 harness 仅使用已有终端标题做 best-effort fallback。

## Architecture

```text
existing Herdr integrations
        │ agent.list: session, status, revision
        ▼
herdr-title-distill launchd service
        ├─ transcript adapter (7 harnesses)
        ├─ OMP title model
        ├─ stale-result guard
        └─ ownership-safe pane/tab sync
```

服务不修改 Herdr，也不替换各 CLI 已有的 Herdr hook。OMP extension 链接只保留包兼容与状态发现；命名逻辑由后台服务统一执行。

## Requirements

- macOS 与 Herdr
- OMP，以及可用的 OMP `@smol` 标题模型
- Bun
- Python 3.10+
- 各目标 harness 已由 Herdr 正常识别；只有要使用的 CLI 才需要安装和登录

## Install or migrate

```bash
python3 scripts/install.py
python3 scripts/install.py --status
```

安装器会：

1. 注册用户级 `com.laike.herdr-title-distill` launchd 服务；
2. 创建 `~/.omp/agent/extensions/herdr-title-distill.ts` 与 `~/.agents/skills/herdr-title-distill` 符号链接；
3. 将确认属于旧项目的 `omp-herdr-title-sync` 注册和 `~/.config/omp-herdr-title-sync/state/` 所有权状态迁入新位置；
4. 拒绝覆盖任何所有权不明的同名文件。

## Verify

隔离验证不创建真实 Herdr pane，也不调用订阅模型：

```bash
python3 scripts/verify.py
```

真实端到端验证必须在 Herdr pane 内执行：

```bash
python3 scripts/verify.py --live --all-harnesses
```

它会在无焦点临时 tab 中运行 OMP、Codex、Grok 各两个不同目标，要求每个标题在 30 秒内更新；同时验证 Pi、Claude Code、Copilot、Hermes fixture、手工名称保护和 multi-pane tab 保护。临时 tab 最终关闭。

覆盖验证模型：

```bash
HERDR_TITLE_DISTILL_MODEL='provider/model' python3 scripts/verify.py --live --all-harnesses
```

## Runtime contract

- 每 750 ms 读取 Herdr agent 状态；没有完成事件时不调用模型。
- 最近最多六条主回合消息参与提炼。
- 标题目标为 2–8 个可见字符，硬上限 10；非法结果整条拒绝，不截断。
- 模型返回后复查 session、终止状态和 transcript fingerprint；过期结果不落盘。
- pane 仅覆盖空名、数字名或本服务上次自动名。
- tab 仅在单 pane 且标签可覆盖时更新。
- 所有权状态：`~/.config/herdr-title-distill/state/`。
- 服务日志：`~/.config/herdr-title-distill/service.log`。

## Uninstall

```bash
python3 scripts/install.py --uninstall
```

卸载只移除本项目拥有的符号链接和 launchd 注册。仍等于最后自动名的活动 pane/tab 尝试恢复原值；用户手改名称不动。状态文件保留，便于审计或重装。

License: MIT.
