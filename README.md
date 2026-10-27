# PocketQuota

**像管理 Agent 一样管理自己的消费习惯。**

Daily limits for real life. One personal ledger, shared by you and your agents.

PocketQuota 把日常池、灵活池、每日限额与自动结余划转做成一个自托管服务。你可以在 WebUI 手动记账，也可以通过 Agent 对话操作同一本账。

![PocketQuota dashboard](docs/preview.jpg)

## 能做什么

- **日常池 / 灵活池 / 保底池**：逐笔选择，默认日常；每日额度或日常余额不足时自动由灵活池补足。保底池不自动动用。
- **真实额度条**：黑白主题、三套光谱、线形或圆环；支出粒子消散、入账光带汇入。支持减少动态效果。
- **赤字状态**：日常与灵活合计耗尽时，整页变红、显示“赤字 · 已破产”，生成可由 Agent 投递的去重通知事件。
- **每日结算**：结余自动转入灵活池；补记、撤销后修正差额。重试不重复扣款。
- **每日 / 每月对账**：实核余额与账面比较，保留差异和历史；不会自动伪造“已对账”。
- **自动入账**：每日补贴、每月生活费，日期和时间可调；短月处理、离线补跑、同一期去重。
- **Agent 原生接口**：13 个 MCP 工具、REST / OpenAPI、function-calling 适配器；独立令牌与读 / 写 / 预算管理权限。
- **可审计**：整数分、SQLite 事务、双边平衡分录、撤销代替删除、CSV 导出、来源与幂等键。

使用说明放在独立的 [guide.html](pocketquota/static/guide.html) 中；服务内右上角“指南”可以直接打开。主界面只保留必要操作。

## 立即运行

Python **3.11+**，运行时没有第三方 Python 或前端依赖。需要系统 IANA 时区数据库（Linux / macOS 通常自带；Windows 可安装 `tzdata`）。

```sh
git clone https://github.com/ReHowever/pocketquota.git
cd pocketquota
python3 -m pocketquota.server --demo --data .demo-data
```

打开 **http://127.0.0.1:18790/**，点击“试用演示账本”。所有演示流水均为虚构。

正式账本使用另一目录，不要把演示数据库用于真实记账：

```sh
python3 -m pocketquota.server --data .data
cat .data/admin.token
```

将本机显示的口令填入登录页。登录后初始化资金池。口令文件只允许当前系统用户读取；网页不将口令存入 localStorage。不要把该文件发送给任何人。

也可以安装 CLI / MCP：

```sh
python3 -m venv .venv
.venv/bin/pip install .
.venv/bin/pocketquota --data .data
```

## Docker

```sh
docker compose up -d --build
docker compose exec pocketquota cat /data/admin.token
```

默认仅映射宿主机回环地址，打开 **http://localhost:18790/**。公网使用 TLS 反向代理，设置 `POCKETQUOTA_ORIGIN=https://budget.example.com` 为你的精确站点来源，并让代理保留原始 Host。不要直接公开 Python HTTP 端口；代理应配置请求超时、并发和速率限制。

后台调度随服务启动，每 30 秒检查到期项目；不需要 LLM 常驻。恢复后补跑离线期间的到期规则。一个数据库只运行一个服务实例（允许多个 Agent 并发调用）；单用户自托管，不是多租户 SaaS。

## 连接 Agent

1. 在 WebUI 的 Agent 页签发专用令牌，默认只读。
2. 在 Agent 运行环境安装本项目，设置 `POCKETQUOTA_URL` 和 `POCKETQUOTA_TOKEN`。
3. 配置标准 MCP stdio：`python3 -m pocketquota.mcp`。

| 客户端 / 框架 | 接入资料 |
| --- | --- |
| Codex | [config.toml 示例](integrations/codex.toml) |
| Claude Code / Desktop、Cursor | [mcpServers 示例](integrations/mcp.json) |
| VS Code Copilot | [含安全口令输入的示例](integrations/vscode.mcp.json) |
| Gemini CLI | [settings.json 片段](integrations/gemini.settings.json) |
| Hermes、其他支持 MCP 的框架 | 同一 stdio 服务器；按该框架原生 MCP 配置接入 |
| DeepSeek / OpenAI-compatible、其他 function-calling 框架 | [工具适配器](docs/agents.md#function-calling) |
| 自定义 Agent、工作流平台 | [REST / OpenAPI](docs/api.md) |

**验证范围**：MCP 协议握手、工具调用与真实本机 HTTP 后端的端到端测试通过。各厂商配置参照其官方文档；未在所有厂商客户端逐一安装验收，也没有发布到其插件商店。Web-only、仅接受远程 HTTP MCP 的客户端不能直接使用这个 stdio 入口；本版暂不提供 OAuth / Streamable HTTP MCP。

### 赤字通知不是隐式发送授权

服务会生成 outbox 事件，但不会自行联系 QQ、邮件或其他渠道。把 [通知工作流](docs/agents.md#通知工作流) 配置给一个已获授权的 Agent：领取事件 → 向账本所有者发送 → 成功后确认。无事件静默；按事件 ID 去重。不需要让模型一直等待。此仓库不会自动修改用户现有 Agent 配置或导入私人历史。

## 预算语义

每个消费日使用当天生效的日限。额度每天当地零点重置；结算时点仅负责结余划转，不是收入。日常超限在消费时立即由灵活池承担，结算不会再次扣款。

金额请求使用字符串（`"12.50"`），返回使用整数分（`1250`）。新规则不能追改过去的日限。支出不会因超额被拒绝，以免真实消费被漏记。额度耗尽指**日常池 + 灵活池 ≤ 0**，不是法律意义的破产。

余额调整是带原因的差额分录；撤销是反向分录。后续补记导致历史余额变化时，旧对账记录会提示需复核。

## 测试与隐私检查

```sh
python3 -m unittest discover -s tests -v
node --check pocketquota/static/app.js
python3 scripts/privacy_check.py
```

运行测试需要本机回环网络权限。测试用临时数据库和动态端口，不使用真实账目或生产令牌。公开发布前另做全 Git 历史密钥扫描和私有信息检查，见 [发布验收](docs/release-check.md)。

## 数据备份

数据库为 `.data/ledger.sqlite3`（Docker 内 `/data/ledger.sqlite3`）。使用 SQLite backup API 产生一致快照：

```sh
python3 -c "import sqlite3; s=sqlite3.connect('.data/ledger.sqlite3'); d=sqlite3.connect('backup.sqlite3'); s.backup(d); d.close(); s.close()"
```

备份包含私人账目和哈希凭据，必须放在安全位置；同时私下备份 `admin.token`。恢复前停服务，恢复数据库，再启动。不要只复制运行中的主库而忽略 WAL 文件。更换 `admin.token` 后须重启服务，现有浏览器会话也会失效；Agent 令牌单独撤销。

## 设计参考与边界

[Actual Budget](https://github.com/actualbudget/actual) 的信封预算与 [API](https://actualbudget.org/docs/api/)、[Firefly III](https://github.com/firefly-iii/firefly-iii) 的预算与审计工作流是产品调研参考；本仓库是独立实现，未复制其源码、前端或商标。详见 [设计说明](docs/design.md)。

PocketQuota v0.1 是个人自托管版本：尚无银行同步、多币种换汇、多用户隔离、第三方安全审计或历史账本自动迁移。仅提供预算和记账，不执行支付或银行转账。

MIT License. 独立项目，与 OpenAI、Anthropic 或其他 Agent 厂商无隶属关系。
