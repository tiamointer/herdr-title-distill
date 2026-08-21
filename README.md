# Herdr Title Distill

开一堆终端跑 agent,回头找不到哪个窗口在干什么——这个服务就是治这个的。每个 agent 干完一轮活,它就读一遍这轮对话,提炼出 2-10 个字,写到 Herdr 的 pane 标题上。比如刚聊完咖啡店起名,标题就变成「咖啡店起名」。

它只干这一件事,不动你的其他东西:你手改过的名字不碰,一个 tab 里有多个 pane 时不碰 tab 名,Herdr 本体和各 CLI 自己的 hook 也不碰。

支持 OMP、Pi、Claude Code、Codex、Grok、Copilot、Hermes。没见过的 harness,如果终端本来就有标题,就拿现成的凑合用。

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

它盯两处的 socket:默认的 `~/.config/herdr/herdr.sock`,加上每个命名会话自己的 `~/.config/herdr/sessions/<名字>/herdr.sock`。`~/.omp/agent/extensions/herdr-title-distill.ts` 这个链接现在只是个空壳占位,不干活;所有命名逻辑都在后台服务里。

## Multi-session

Herdr 的每个会话有自己的 socket。服务启动时把现存的全找出来,一个会话派一个监听者。

之后每 30 秒再扫一遍目录。你新开一个命名会话,半分钟内自动接管,不需要任何手动激活。嫌快嫌慢,改 plist 里的 `HERDR_TITLE_DISTILL_RESCAN_MS`(毫秒,默认 30000)。

每个会话的已处理进度记在自己单独的小本子上(`service.json` 管 default,`service.<会话名>.json` 管命名会话),互不干扰,pane 编号在各会话里本来就不通用。

## When titles update

标题只在 agent 从「干着活」变成「干完了」的那一刻触发。pane 开着但一直没干活,标题不动;这不是坏了,是没到时候。改完名后 30 秒内,日志里能看到对应 pane 的 `title-synced` 事件。

## Requirements

- macOS 与 Herdr
- OMP,以及可用的 OMP `@smol` 标题模型
- Bun
- Python 3.10+
- 各目标 harness 已由 Herdr 正常识别;只有要使用的 CLI 才需要安装和登录

## Install or migrate

```bash
python3 scripts/install.py
python3 scripts/install.py --status
```

装完它会:注册 `com.laike.herdr-title-distill` 这个用户级后台服务;建两个符号链接(`~/.omp/agent/extensions/herdr-title-distill.ts` 和 `~/.agents/skills/herdr-title-distill`);如果发现旧 `omp-herdr-title-sync` 的注册和状态文件,确认是它自己的就搬过来;不是自己的同名文件,一个都不覆盖。

## Verify

先跑隔离验证,不建真实 pane、不调模型:

```bash
python3 scripts/verify.py
```

要跑真刀真枪的端到端验证,得在一个 Herdr pane 里执行:

```bash
python3 scripts/verify.py --live --all-harnesses
```

它会开一个不抢焦点的临时 tab,真启动 OMP、Codex、Grok 各跑两个不同任务,要求每个标题 30 秒内更新;Pi、Claude Code、Copilot、Hermes 用现成的对话记录验证;顺带验证手改名保护和多 pane tab 保护。跑完临时 tab 自己关掉。

想换个模型验证也行:

```bash
HERDR_TITLE_DISTILL_MODEL='provider/model' python3 scripts/verify.py --live --all-harnesses
```

## Runtime contract

- 每 750 ms 读一次 Herdr agent 状态;没有完成事件就不调模型,不花冤枉钱。
- 最近最多六条主回合消息参与提炼。
- 标题目标 2-8 个可见字符,硬上限 10;模型返回的非法结果整条拒绝,不截断救回。
- 模型返回后复查 session、终止状态和对话指纹;过期结果直接丢弃,不落盘。
- pane 只覆盖空名、数字名、或本服务上次的自动名。
- tab 只在单 pane 且标签可覆盖时更新。
- 多会话 socket 发现 + 30 秒重扫,见 Multi-session 节。
- 日志事件带 `session` 字段,标明是哪个会话的事。
- 所有权状态:`~/.config/herdr-title-distill/state/`。
- 服务日志:`~/.config/herdr-title-distill/service.log`。

## Troubleshooting

**标题没更新?** 先看那个 agent 是不是真的闲着了——只有干完活才改。再看日志:

```bash
tail ~/.config/herdr-title-distill/service.log
```

找 `session-watch-started` 里有没有你那个会话,再找对应 pane 的 `title-synced`。都没有,等 30 秒重扫;有 `title-generation-failed`,看它给的 reason。

**新开的会话没被管?** 等一个重扫周期(默认 30 秒)。还不行,确认 `~/.config/herdr/sessions/<名字>/herdr.sock` 这个文件存在。

**标题变得很长、不是中文短语风格了?** 那不是本服务的产出,是 OMP 内置命名的兜底——说明那个会话没被盯上,按上一条排查。

**想确认服务活没活?** `python3 scripts/install.py --status` 看 `service: running`,或 `pgrep -fl daemon.ts`。

**手改的名字会被覆盖吗?** 不会。只有空名、数字名、或仍是本服务上次自动名这三种才覆盖;你手改过的算手工名,不动。

## Uninstall

```bash
python3 scripts/install.py --uninstall
```

只拆本服务自己的符号链接和后台服务注册。活动 pane 上如果标题还等于最后一次自动名,会试着还原;你手改过的不动。状态文件留着,方便审计或重装。

License: MIT.
