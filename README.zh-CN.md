# OpenGrokBot 🦞🤖

> 一支随时在线的 AI 同事班子，**每个人一台自己的电脑**——跑在你自己的机器上，凭证在你自己手里。

[English](README.md) · [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-blue?style=flat-square)](../../pulls)

xAI 的 Grok Bot 卖的是「随时在线的同事」：每个 bot 配一台云电脑（浏览器、文件系统、终端），有持久记忆，彼此
能交接工作，还有一个 iMessage 形状的 app 来管他们。价格 **每人每月 $120–300**，而且每个 bot 都跑在 xAI 的云
上，**你的登录态也一起在里面**。

这个仓库是同样的形状，自托管版：你机器上一个 gateway 进程、每个 bot 一个 Docker 容器、一个长得像消息应用的网页
客户端，后面接任何 OpenAI 兼容的模型。

## 这里的「同事」到底是什么

一个带 `SOUL.md` 的文件夹、侧栏里的一条线程，外加一台自己的电脑：

```
┌─ 网页客户端 ──────── 侧栏即组织架构 · chip 即管理界面
│      ↕ WebSocket
├─ Gateway（单个 Node 进程）── agent 循环 · SQLite · 调度器 · a2a 总线 · Docker
└─ 每个 bot 一个容器
     ├─ Xvfb 上的有头 Chromium  → 像人一样浏览，登录态能留下来
     ├─ x11vnc + noVNC          → 你能看它的屏幕，也能接管键盘
     ├─ 一个迷你 shim           → shell 与文件，只绑在容器内
     └─ /workspace 卷           → SOUL.md · MEMORY.md · 文件 · 浏览器 profile
```

凭证只存在**它的**浏览器 profile、**它的**容器里。gateway 看不到密码，配置文件里也不会有。

## 现在已经能做什么

下面每一条都已实现且有测试覆盖，没有一条是路线图。

**管理界面**

- **侧栏即组织架构。** 每个同事一条线程，外加群线程。预览显示的是完成态，扫一眼列表等于巡一遍工位。
- **统一的汇报语法。** 干完的活以 `✓ 系统 → 结果 · 数字` 回来，最后一句人话只说需要你决定的事。所有同事同一种
  格式。
- **默认扣住的审批链。** 任何要出门的动作都停在门口：chip 里写清到底会发出去什么，配 Approve / Discard 两颗
  按钮。在线程里发一个光秃秃的 👍 就放行最新那条。决议是幂等的——重复点击拿到 409，而不是发第二遍。
- **看得见的记忆。** 「以后安静客户的邮件等我读过再发」会把这条规矩写进那个 bot 的 `MEMORY.md`，并把 diff 作为
  chip 贴出来。下一轮对话它就带着这条规矩了。
- **从对话里长出来的 routine。** 「以后每天发一份摘要」会登记一条 cron，用人话显示排期，重启后自动重载，到点
  真的自己跑。

**电脑**

- 容器里的 `shell`、`read_file`、`write_file`。
- `browser_goto` / `browser_extract` / `browser_click` 操作真正的有头 Chromium——所以有登录墙的站点也能干活，
  这是纯 API/MCP 方案做不到的。
- `browser_screenshot` 把它看到的画面贴进聊天当证据。
- **接管登录。** 撞上登录墙时，bot 调 `ask_for_login` 而不是问你要密码。你从线程里打开它的屏幕，在**它的**浏览器
  里登录一次，会话就留在它的 profile 里——容器重启也还在。
- 容器懒启动、扛得住重启，端口只发布到 `127.0.0.1`。

**这支班子**

- **群线程。** 在群里问一句：每位同事只报自己那摊，最后由幕僚长收口发分派表——`✓ 事项 → @bot · 期限`——再加
  一句今天需要你的是什么。
- **走白名单的交接。** `message_bot` 把一件划好范围的活丢进另一位同事的线程并叫醒他。默认只有幕僚长能联系所有
  人，同级互发要显式指定方向。转发最多两跳，两个 bot 不会互相回声。
- **从侧栏雇人。** 点 `+`、填个名字、一句职位描述。没有工作流编辑器，没有工具勾选清单——复杂度积累在使用过程
  中，而不是前置在表单里。

## 快速开始

需要 Node 22+、pnpm，以及 Docker（给 bot 的电脑用）。

```bash
git clone https://github.com/wolfqing/OpenGrokBot.git
cd OpenGrokBot
pnpm install
docker build -t opengrokbot/bot:dev docker/bot
```

不用任何 API key 就能试——内置的脚本化假模型能把每条链路都跑通：

```bash
OPENGROKBOT_MODEL=stub pnpm dev
```

然后打开 http://localhost:5173。

接真模型（任何 OpenAI 兼容的都行：xAI、Kimi、DeepSeek、本地 Ollama）：

```bash
OPENGROKBOT_API_KEY=sk-… OPENGROKBOT_MODEL=grok-4 pnpm dev
```

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `OPENGROKBOT_API_BASE` | `https://api.x.ai/v1` | 任何 OpenAI 兼容端点 |
| `OPENGROKBOT_API_KEY` | — | 你的 key，本仓库不会把它写进任何文件 |
| `OPENGROKBOT_MODEL` | `grok-4` | 填 `stub` 可离线零 key 运行 |
| `OPENGROKBOT_DATA` | `gateway/data` | SQLite、bot 工作区、截图 |
| `OPENGROKBOT_A2A_ALLOW` | *(空)* | 同级交接，如 `researcher>market-watch` |

国内网络建议挂镜像源构建：`docker build --build-arg APT_MIRROR=mirrors.aliyun.com …`

## 安全不是脚注，是全部理由

对「托管式常驻 agent」最响的反对声：一个永不休眠、手握你全部凭证的 agent，跑在别人的基础设施上，还暴露在提示词
注入面前。自托管的回答是：

- **凭证不出你的机器。** 它们在 bot 的浏览器 profile 里，在它自己的容器里。
- **bot 不会在聊天里问密码。** 它只会请你接管它的屏幕。
- **每个 bot 天生在笼子里**——独立容器、独立工作区，碰不到你的宿主机。
- **对外动作只会被扣住**，等你批准才发。
- **bot 之间默认不能互发消息**，要你显式放行方向。
- **屏幕只绑 `127.0.0.1`。** 这个面板是给本机用的，别做端口转发。
- **进来的消息一律当不可信输入。** 对外暴露任何东西之前请先读 [docs/security.md](docs/security.md)。

给 bot 配它们自己的账号，而不是你的——独立邮箱、独立日历，只邀请进它真正需要的地方。这对托管式 agent 同样是正确
答案，只不过在这里你能真的落实。

## 成本

| | Grok Bot | OpenGrokBot |
|---|---|---|
| 软件 | $120–300/月/席 | $0（一路 MIT） |
| 算力 | 含（xAI 的云） | 你现有的 Mac / 小主机 / ~$5 VPS |
| 模型 | 含（只有 Grok） | 你自己的 key，任意厂商——本地模型则 $0 |
| 你的登录态 | 在 xAI 云上 | 在你机器上的容器里 |

说句公道话：Grok Bot 的开箱即用、iOS app、看着你操作就学会，这三样是真优势。如果你不介意把账号放在 xAI 云上，
也愿意为省事付钱，那就买它。这个仓库是给那些对「你能接受吗？」回答**不能**的人准备的。

## 路线图

- [ ] **teach-mode**——录一遍浏览器操作，编译成可复用的 routine。这是 Grok Bot 唯一没有开源等价物的能力，设计
      讨论在 [#1](../../issues/1)
- [ ] Telegram 作为离开电脑时的通知 / 审批补位渠道
- [ ] 一条命令起 VPS 镜像（cloud-init）
- [ ] 原生 app 外壳

## 常见问题

**和 Grok Bot 是什么关系？** 同一件事——常驻同事、各自的电脑、持久记忆、互相交接——但托管模型相反，且**零共享
代码**（Grok Bot 闭源，根本无从 fork）。它甚至可以用同一个大脑：把 API 指向 Grok 即可。

**和 OpenClaw 是什么关系？** 本仓库 v0.1 是 OpenClaw 之上的一个发行版。v0.2 换成了自研核，因为「每个同事一台
自己的电脑」和 OpenClaw 的共享主机模型是拧着的。旧配方保留在
[docs/openclaw-recipe.md](docs/openclaw-recipe.md)。本项目不是 OpenClaw 官方项目。

**必须用 Docker 吗？** 电脑那部分必须。其余能力——线程、审批、记忆、routine、群分派——没有 Docker 也照常运转，
bot 只会如实说自己现在没有电脑。

更多见 [docs/faq.md](docs/faq.md) · [docs/multi-bot.md](docs/multi-bot.md) · [docs/comparison.md](docs/comparison.md)

## 免责声明

非官方项目，与 xAI 或 OpenClaw Foundation 无任何隶属、背书或关联关系。"Grok" 是 xAI 的商标，此处仅用于指明本项目
所对标的产品。

## License

[MIT](LICENSE)。如果它帮你省下每月 $300，点个 star。⭐
