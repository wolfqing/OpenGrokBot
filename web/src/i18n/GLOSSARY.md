# 中文用词表

界面中文（`zh-CN.ts`）按这张表用词。原则：说人话，不直译；同一个东西全界面只有一个叫法。
加新文案时先查这里；要新造一个词，先加进这张表。

## 人和东西

| 英文 | 中文 | 说明 |
|---|---|---|
| teammate | 同事 | 不说「机器人」「智能体」「bot」。量词「位」：一位同事 |
| chief | Chief | 名字，不翻 |
| hire | 雇 | 「雇一位同事」，不说「创建」「添加」 |
| you / operator | 你 | 不说「用户」「操作员」 |
| computer | 电脑 | 同事干活用的那台，不说「环境」「实例」 |
| local computer | 本机电脑 | 跑在这台机器上的浏览器 + 文件夹 |
| sealed computer | 密封电脑 | Docker 容器；不说「容器电脑」「沙盒电脑」 |
| sandbox | 沙箱 | 只在命令行这件事上出现 |
| commands / shell | 命令行 / 跑命令 | 开关叫「允许跑命令」 |
| gateway | 网关 | |
| token (sign-in) | 令牌 | 登录用的那串 |
| token (model use) | token | 计费单位不翻：「12,345 个 token」 |
| group / room | 群聊 / 群 | |
| thread | 对话 | 不说「线程」「会话」 |

## 事情和动作

| 英文 | 中文 | 说明 |
|---|---|---|
| approval | 审批 | 「等你审批」 |
| approve / discard | 批准 / 驳回 | discard 不说「丢弃」 |
| always allow | 一直放行 | 点了就存一条放行规矩 |
| revoke | 撤销 | |
| standing rule (memory) | 长期规矩 | 同事记在 MEMORY.md 里的；不说「规则」，免得和放行规矩混 |
| rule (allow rule) | 放行规矩 | 「不用问就放行」那一栏里的；英文审批卡片上的 standing rule 也是它，不是长期规矩 |
| memory | 记忆 | |
| routine | 例行任务 | 定时的、webhook 触发的都叫这个 |
| watch | 值守 | 只看不动、有事才出声的例行任务 |
| handoff | 转交 | 同事之间 |
| take over / sign in for it | 接管 / 登录 | 你在它的浏览器里亲手操作 |
| needs you | 等你 | 侧栏状态 |
| working / stuck / done | 在干活 / 卡住了 / 干完了 | |
| step | 步 | 「3 步」 |
| report | 报告 | 「已交报告」 |
| skill | 技能 | 「共享技能」 |
| webhook | webhook | 不翻；外部来的数据叫「外部数据」 |
| destination / target | 去处 | 放行规矩管的「发给谁、发到哪」 |
| wildcard | 通配 | |
| budget (tokens) | token 预算 | |
| limit (per turn) | 上限 | 「一个回合 30 步的上限」 |
| image (Docker) | 镜像 | |

## 写法

- 中文标点（，。：「」…），引号用「」；中英文之间不强制加空格，但数字和单位之间加：「12 秒」「3 步」。
- 品牌名（OpenSuperBot、Chief、GitHub、DeepSeek……）和同事的名字原样。
- 按钮用动词短语，短：「批准」「停下」「我登录好了」。
- 同事说的话、模型生成的内容不在词典里。网关回来的原因带代码（`error.*`、`block.*`、`sandbox.*`、`notice.*`），
  在词典里翻；认不出的代码就显示网关的英文原话。
