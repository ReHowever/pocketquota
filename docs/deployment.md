# 部署与维护

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

默认仅映射宿主机回环地址，打开 **http://localhost:18790/**。公网使用 TLS 反向代理，设置 `POCKETQUOTA_ORIGIN=https://budget.example.com` 为你的精确站点来源，并让代理保留原始 Host。不要直接公开 Python HTTP 端口；代理应配置请求超时、并发和速率限制。

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
