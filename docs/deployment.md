# 部署与维护

## 立即运行

Python **3.11+**，运行时没有第三方 Python 或前端依赖。需要系统 IANA 时区数据库（Linux / macOS 通常自带；Windows 可安装 `tzdata`）。

```sh
git clone https://github.com/ReHowever/pocketquota.git
cd pocketquota
python3 -m pocketquota.server --demo --data .demo-data
```

打开 [本机地址](http://127.0.0.1:18790/)，点击“试用演示账本”。所有演示流水均为虚构。

正式账本使用另一目录，不要把演示数据库用于真实记账：

```sh
python3 -m pocketquota.server --data .data
cat .data/initial-admin.json
```

默认账号为 `admin`，密码在首次启动时随机生成（26 位），从初始信息文件读取。首次成功登录后，初始文件自动移除；数据库只保存随机盐和 scrypt 哈希。登录后初始化资金池。账号页可新建用户、一次性复制随机初始密码、停用或重置账号。每个用户独立初始化自己的账本。

也可以安装 CLI / MCP：

```sh
python3 -m venv .venv
.venv/bin/pip install .
.venv/bin/pocketquota --data .data
```

## Docker

```sh
docker compose up -d --build
docker compose exec pocketquota cat /data/initial-admin.json
```

默认仅映射宿主机回环地址，打开 [本机地址](http://localhost:18790/)。公网使用 TLS 反向代理，设置 `POCKETQUOTA_ORIGIN=https://budget.example.com` 为你的精确站点来源，并让代理保留原始 Host。不要直接公开 Python HTTP 端口；代理应配置请求超时、并发和速率限制。

后台调度随服务启动，每 30 秒检查到期项目；不需要 LLM 常驻。恢复后补跑离线期间的到期规则。一个数据目录只运行一个服务实例。支持多个用户及其 Agent，使用独立账本数据库；账号数据库集中管理身份与令牌归属。站点管理员负责创建用户，默认不开放匿名注册。

## 数据备份

数据库为 `.data/ledger.sqlite3`（Docker 内 `/data/ledger.sqlite3`）。使用 SQLite backup API 产生一致快照：

```sh
python3 -c "import sqlite3; s=sqlite3.connect('.data/ledger.sqlite3'); d=sqlite3.connect('backup.sqlite3'); s.backup(d); d.close(); s.close()"
```

备份包含私人账目和哈希凭据，必须放在安全位置；多账号实例还需要备份 `accounts.sqlite3`、`users/` 内的各用户账本及本机管理 API 的 `admin.token`。恢复前停服务，恢复数据库，再启动。不要只复制运行中的主库而忽略 WAL 文件。网页密码与 Agent 令牌分开管理；重置密码会撤销该账号全部会话与 Agent 令牌。默认管理员密码丢失时可在服务器本地运行 `python3 -m pocketquota.accounts reset-admin --data .data`，返回一个新的随机密码。


## 开发与验收

```sh
python3 -m unittest discover -s tests -v
node --check pocketquota/static/app.js
python3 scripts/privacy_check.py
```

完整测试覆盖与发布检查见 [发布验收](release-check.md)，部署边界与凭据管理见 [安全说明](../SECURITY.md)。


## 资金池图形与余额编辑

首页灵活池以蓄水池展示，固定池以保险柜展示；内部资金池键仍为 flex / reserve。水位为随余额单调变化的装饰，不代表一个虚构的储蓄目标。余额归零时水体隐藏，固定池归零时柜内钞票隐藏。

存入与取出复用现有 /api/entries 幂等接口：池内调拨用 transfer；明确选择外部收入或实际支出才用 income / expense。三个资金池的金额均可通过现有 /api/adjust 修改，必须填写原因并保留审计记录。只在服务器成功返回新余额后播放升降水位、解锁、开门与存取动画；刷新前后净变动相同则不播放存取。外观动效开关与系统减少动态效果偏好均生效。

窄屏使用单列表单、完整的按钮文字与金额、整行统计卡，较大金额单独占行。多列流水局部横向滚动；正文可自然换行。首页已检查320/390/768/1024/1440宽度；规则、流水、对账、Agent、账号页已检查320宽度。隔离演示账本实测存入、取出、跨池转入、三个余额修改、零余额、大金额和动效关闭；现有41项测试通过。

## 多接口监听

在受信的私有网络中需要给反向代理和容器各提供入口时，可运行源码中的示例：

```sh
python3 integrations/serve_dual.py --data .data --origin https://budget.example.com --listen 127.0.0.1
```

`--listen` 可重复传入明确的私有 IPv4 接口。HTTPS 由反向代理终止，代理应转发公共 Host，并通过防火墙限制后端访问。所有监听共享同一个 App 和调度器；默认回环监听，不自动开放公网端口。启动前确保源码已安装，例如 `python3 -m pip install -e .`。

## 离线迁入旧支出

先停止目标实例并备份完整数据目录；确认切换日三个池的余额，再初始化目标账户账本。通过 `pocketquota.import_legacy.import_records(ledger, records, budget_snapshot)` 导入切换日之前的历史支出。`ledger` 必须是明确选择的目标账户账本；此函数不自动猜测用户或查找其他账户。

每条记录包含稳定 `record_id`、ISO `date`、十进制金额 `amount`，可选 `item`、`note`、`timestamp`、`pool`。旧数值金额仅按其字符串形式解析，超过两位小数直接拒绝，不静默四舍五入。记录的其他字段保存在本人可导出的原始归档；导入前应确认其中没有无关的敏感字段。

历史记录不会再次扣余额，不参与新账本的每日结算；撤销历史记录只修正统计和归档状态。如果需要修正当前余额，另行建立注明原因的余额调整。同源记录或预算快照变化时拒绝整批导入，避免静默覆盖审计数据。
