# REST API

GET `/openapi.json` 返回实时 OpenAPI 3.1 文档（Agent 接口）。API 返回金额为整数分，写入金额使用十进制字符串。请求最大 64 KiB。

所有账本接口须 `Authorization: Bearer <专用令牌>`。每次写操作附 `Idempotency-Key`（8–128 位字母、数字、点、下划线、冒号或连字符）。同一次用户意图的重试使用同一个键；新意图使用新键。不得通过 URL 传密钥。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/dashboard | 今日额度、资金池、月汇总、破产状态 |
| GET | /api/entries?start=YYYY-MM-DD&end=YYYY-MM-DD&offset=0&limit=100 | 分页流水 |
| POST | /api/entries | 支出 / 收入 / 转账 |
| POST | /api/reverse | 原流水 ID + 撤销原因 |
| GET | /api/summary?period=YYYY-MM | 已结束周期的账面余额 |
| POST | /api/reviews | 记录实核余额和差异 |
| GET | /api/reviews | 对账记录（含是否需复核） |
| GET | /api/schedules | 自动入账计划 |
| GET | /api/notifications | 未确认通知事件 |
| POST | /api/notifications/ack | 成功通知用户后确认事件 |
| GET | /api/export.csv | 导出流水（防电子表格公式注入） |
| GET | /api/rules | 生效日期与额度版本 |
| POST | /api/settings | 修改日限 / 时间 / 结转；需要 manage |
| POST | /api/schedules | 创建、编辑或暂停计划；需要 manage |
| POST | /api/adjust | 调整资金池；需要 manage |
| POST | /api/settle | 主动结算；需要 manage |

## 记一笔

```json
{"kind":"expense","amount":"25.00","pool":"daily","category":"餐饮","note":"晚餐"}
```

日期默认账本当地今天；可传 `date` 补记。转账用 `kind: transfer`，`pool` 指转出池，`to_pool` 指转入池。响应包含实际 `allocation`（日常 / 灵活承担额）。

## 对账

```json
{"period":"2026-01-30","actual":{"daily":"100.00","flex":"25.00","reserve":"500.00"},"note":"手动核对"}
```

月对账使用 `YYYY-MM`，仅允许已结束月份。实际余额必须来自用户核对，不能自动复制账面值。

## 管理与安全

读取 `/api/dashboard` 得到 `settings.revision`，修改规则时原样提供；过期版本返回 409，避免多个 Agent 互相覆盖。默认令牌只读，写入需 read/write；管理需 read/write/manage。只有所有者能创建或撤销令牌。

403 表示来源 / 权限错误；409 为幂等或状态冲突；400 为参数校验失败。失败时不应换幂等键盲目重发。网页使用 Cookie + Origin 校验 + CSRF，不使用 Agent 令牌。
