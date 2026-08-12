# OMP Herdr Title Sync

无模型的 OMP → Herdr 短标题同步器。它复用 OMP 已有的 session title，用确定性规则压缩到最多 10 个可见字符，再安全地同步到 Herdr pane；单 pane tab 会跟随同步，多 pane tab 和手工名称受到保护。

## Features

- 不调用 Claude、Codex 或其他模型生成标题
- 不访问网络 API；运行时只使用 Bun/Node 标准库和 Herdr Unix socket
- 自动保护手工修改过的 pane/tab 名称
- 同名单扩展文件存在时拒绝覆盖
- 支持精确标题别名
- 支持隔离验证与真实 Herdr 验证

## Requirements

- macOS 或其他能运行 Herdr 的环境
- `herdr` 已安装并在 `PATH` 中
- OMP 已安装并支持 agent extensions
- Python 3.10+
- Bun（隔离验证和运行时测试需要）

## Install

Clone this repository, then run:

```bash
python3 scripts/install.py
```

安装器只会在 `~/.omp/agent/extensions/omp-herdr-title-sync.ts` 创建指向本仓库 `extension/index.ts` 的符号链接。若目标存在同名的非本项目文件，安装器会停止并拒绝覆盖。

查看状态：

```bash
python3 scripts/install.py --status
```

新启动的 OMP 会话会加载扩展；已运行的会话不会热加载。

## Aliases

在 `config/aliases.json` 中配置精确别名：

```json
{
  "aliases": {
    "原始 OMP 标题": "期望短标题"
  }
}
```

别名值最多 10 个可见字符，并在下一次标题变化时生效。

## Verify

不创建 Herdr 临时 pane 的隔离验证：

```bash
python3 scripts/verify.py
```

在 Herdr pane 中执行真实验证：

```bash
python3 scripts/verify.py --live
```

真实验证会创建无焦点临时 tab/pane，并在结束前关闭它们；测试 OMP 会话不会发送 prompt，也不会调用模型。

也可以单独运行运行时测试：

```bash
bun tests/runtime_check.ts
```

## Uninstall

```bash
python3 scripts/install.py --uninstall
```

卸载只移除本项目拥有的符号链接。仍等于最后自动标题的活动 pane/tab 会尝试恢复原值；被用户手动改过的名称保持不动。

## Runtime contract

- 默认每 750 ms 检查一次 `pi.getSessionName()`。
- 只有标题变化时才访问 Herdr socket。
- pane 只有在空名、数字名或仍等于上次自动标题时才会更新。
- tab 只有在 `pane_count == 1` 时更新。
- 状态写入 skill 目录下的 `state/`，按 Herdr terminal ID 分文件。
- Herdr 不可用、socket 超时或响应结构不合法时，运行时静默跳过并在下一次检查重试。

## Repository boundary

`state/` 是本机运行时数据，不属于源代码；不要提交其中的 terminal ID、pane ID 或标题记录。`__pycache__/` 和本地测试产物也不应提交。

License: MIT.
