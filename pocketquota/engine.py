"""Integer-money journal. All financial writes are serialized SQLite transactions."""
from __future__ import annotations

import calendar
import hashlib
import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

POOLS = ("daily", "flex", "reserve")


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def money(value, signed=False):
    # Decimal strings on the wire: never round or silently accept binary floats.
    if not isinstance(value, str) or not re.fullmatch(r"-?\d{1,10}(?:\.\d{1,2})?", value):
        raise Problem("金额须为最多两位小数的字符串，如 12.50")
    result = int(Decimal(value) * 100)
    if not signed and result < 0:
        raise Problem("金额不能为负")
    return result


def text(value, maximum=240):
    if not isinstance(value, str) or len(value) > maximum:
        raise Problem("文本格式或长度不正确")
    return value.strip()


def day(value):
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError()
        return parsed
    except (TypeError, ValueError):
        raise Problem("日期须为 YYYY-MM-DD") from None


def clock(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        raise Problem("时间须为 HH:MM")
    return value


def pool(value):
    if value not in POOLS:
        raise Problem("资金池必须为 daily、flex 或 reserve")
    return value


def pack(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Connection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class Ledger:
    def __init__(self, path, now=None):
        self.path = str(path)
        self.now = now or (lambda: datetime.now(timezone.utc))
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS rules(id INTEGER PRIMARY KEY, effective TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS entries(
              id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL,
              amount INTEGER NOT NULL, pool TEXT NOT NULL, category TEXT NOT NULL,
              note TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
              reverses TEXT UNIQUE REFERENCES entries(id));
            CREATE TABLE IF NOT EXISTS postings(
              entry_id TEXT NOT NULL REFERENCES entries(id), pool TEXT NOT NULL, cents INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS entry_date ON entries(date);
            CREATE TABLE IF NOT EXISTS settlements(date TEXT PRIMARY KEY, allowance INTEGER NOT NULL,
              spent INTEGER NOT NULL, transferred INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS schedule_runs(schedule_id TEXT NOT NULL, date TEXT NOT NULL,
              entry_id TEXT NOT NULL, PRIMARY KEY(schedule_id,date));
            CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, period TEXT NOT NULL, date TEXT NOT NULL,
              expected TEXT NOT NULL, actual TEXT NOT NULL, difference TEXT NOT NULL,
              note TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS review_due(period TEXT PRIMARY KEY, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL,
              actor TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL UNIQUE,
              scopes TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL,
              created_at TEXT NOT NULL, acknowledged_by TEXT, acknowledged_at TEXT);
            """)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=20, isolation_level=None, factory=Connection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def stamp(self):
        return self.now().isoformat()

    def audit(self, db, actor, action, data):
        db.execute("INSERT INTO audit(at,actor,action,data) VALUES(?,?,?,?)",
                   (self.stamp(), actor, action, pack(data)))

    def initialized(self, db):
        return db.execute("SELECT 1 FROM meta WHERE key='settings'").fetchone() is not None

    def settings(self, db):
        row = db.execute("SELECT value FROM meta WHERE key='settings'").fetchone()
        if not row:
            raise Problem("请先初始化账本", 409)
        return json.loads(row[0])

    def today(self, db):
        return self.now().astimezone(ZoneInfo(self.settings(db)["timezone"])).date()

    def dated(self, db, value):
        d = day(value)
        if not day(self.settings(db)["start_date"]) <= d <= self.today(db):
            raise Problem("记账日期必须在账本起始日与今天之间")
        return d.isoformat()

    def rule(self, db, date_str):
        row = db.execute("SELECT data FROM rules WHERE effective<=? ORDER BY effective DESC,id DESC LIMIT 1",
                         (date_str,)).fetchone()
        return json.loads(row[0]) if row else {"daily_limit": 0, "carry_over": True}

    def balances(self, db, date_str=None):
        q = "SELECT p.pool,SUM(p.cents) FROM postings p JOIN entries e ON e.id=p.entry_id"
        rows = db.execute(q + (" WHERE e.date<=?" if date_str else "") + " GROUP BY p.pool",
                          (date_str,) if date_str else ()).fetchall()
        amounts = dict(rows)
        return {k: amounts.get(k, 0) for k in POOLS}

    def spent(self, db, d):
        return db.execute("""SELECT COALESCE(SUM(CASE WHEN e.kind='expense' THEN e.amount ELSE -e.amount END),0)
          FROM entries e WHERE e.date=? AND e.pool='daily' AND (e.kind='expense' OR
          (e.kind='reversal' AND e.reverses IN (SELECT id FROM entries WHERE kind='expense')))""", (d,)).fetchone()[0]

    def check_bankruptcy(self, db):
        balances = self.balances(db)
        bankrupt = balances['daily'] + balances['flex'] <= 0
        previous = db.execute("SELECT value FROM meta WHERE key='bankrupt'").fetchone()
        if bankrupt and (not previous or previous[0] != 'true'):
            data = {"message": "可消费额度已耗尽：已破产，请核对支出或补充资金。保底池未自动动用。",
                    "balances": balances, "deficit": max(0, -balances['daily'] - balances['flex'])}
            db.execute('INSERT INTO notifications(id,kind,data,created_at) VALUES(?,?,?,?)',
                       (uuid.uuid4().hex, 'budget_exhausted', pack(data), self.stamp()))
        db.execute("INSERT OR REPLACE INTO meta VALUES('bankrupt',?)", ('true' if bankrupt else 'false',))

    def post(self, db, d, kind, amount, target, category, note, actor, postings, reverses=None):
        assert sum(postings.values()) == 0, "Unbalanced journal entry"
        identifier = uuid.uuid4().hex
        db.execute("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?)",
                   (identifier, d, kind, amount, target, category, note, actor, self.stamp(), reverses))
        db.executemany("INSERT INTO postings VALUES(?,?,?)", [(identifier, k, v) for k, v in postings.items() if v])
        self.audit(db, actor, kind, {"entry_id": identifier})
        return identifier

    def mutate(self, operation, data, actor, key):
        if not isinstance(data, dict):
            raise Problem("请求必须为 JSON 对象")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", key):
            raise Problem("写操作须提供 8–128 字符的 Idempotency-Key")
        digest = hashlib.sha256(pack([operation, data]).encode()).hexdigest()
        request_key = actor + ":" + key
        with self.transaction() as db:
            row = db.execute("SELECT digest,result FROM requests WHERE key=?", (request_key,)).fetchone()
            if row:
                if row[0] != digest:
                    raise Problem("同一幂等键不能用于不同内容", 409)
                return json.loads(row[1])
            if operation != "setup" and not self.initialized(db):
                raise Problem("请先初始化账本", 409)
            method = getattr(self, "do_" + operation, None)
            if method is None:
                raise Problem("未知操作", 404)
            result = method(db, data, actor)
            self.check_bankruptcy(db)
            db.execute("INSERT INTO requests VALUES(?,?,?)", (request_key, digest, pack(result)))
            return result

    def do_setup(self, db, data, actor):
        if self.initialized(db):
            raise Problem("账本已初始化", 409)
        tz = text(data.get("timezone", "Asia/Shanghai"), 80)
        try:
            local = self.now().astimezone(ZoneInfo(tz))
        except (ZoneInfoNotFoundError, ValueError):
            raise Problem("时区无效") from None
        cfg = {"name": text(data.get("name", "我的额度"), 60), "timezone": tz,
               "currency": "CNY", "start_date": local.date().isoformat(),
               "settle_time": clock(data.get("settle_time", "21:00")), "review_day": 1,
               "review_time": "09:00", "revision": 1}
        db.execute("INSERT INTO meta VALUES('settings',?)", (pack(cfg),))
        limit = money(data.get("daily_limit", "60.00"))
        db.execute("INSERT INTO rules(effective,data) VALUES(?,?)",
                   (cfg['start_date'], pack({"daily_limit": limit, "carry_over": True})))
        for target in POOLS:
            amount = money(data.get(target, "0.00"))
            if amount:
                self.post(db, cfg['start_date'], 'opening', amount, target, '', '期初余额', actor,
                          {target: amount, 'external': -amount})
        self.audit(db, actor, 'setup', {"timezone": tz})
        return {"ok": True}

    def do_entry(self, db, data, actor):
        kind = data.get("kind", "expense")
        if kind not in ("expense", "income", "transfer"):
            raise Problem("仅支持支出、收入和池间转账")
        amount = money(data.get("amount"))
        if amount <= 0:
            raise Problem("金额须大于零")
        target = pool(data.get("pool", "daily"))
        d = self.dated(db, data.get("date", self.today(db).isoformat()))
        category = text(data.get('category', ''), 40)
        note = text(data.get('note', ''))
        closed = db.execute('SELECT 1 FROM settlements WHERE date=?', (d,)).fetchone() is not None
        if closed and kind == 'expense' and target == 'daily':
            # Temporarily unwind that day's carry before allocating a late expense.
            self.unsettle(db, d, actor)
        allocation = {}
        if kind == 'transfer':
            other = pool(data.get('to_pool'))
            if other == target:
                raise Problem('转入与转出池不能相同')
            postings = {target: -amount, other: amount}
        elif kind == 'expense' and target == 'daily':
            allowance = max(0, self.rule(db, d)['daily_limit'] - self.spent(db, d))
            daily_part = min(amount, allowance, max(0, self.balances(db)['daily']))
            flex_part = amount - daily_part
            postings = {'daily': -daily_part, 'flex': -flex_part, 'external': amount}
            allocation = {'daily': daily_part, 'flex': flex_part}
        else:
            change = amount if kind == 'income' else -amount
            postings = {target: change, 'external': -change}
        identifier = self.post(db, d, kind, amount, target, category, note, actor, postings)
        if db.execute('SELECT 1 FROM settlements WHERE date=?', (d,)).fetchone():
            self.settle(db, d, actor)
        elif kind == 'expense' and target == 'daily':
            self.rebalance_day(db, d, actor)
        return {"id": identifier, "allocation": allocation, "balances": self.balances(db)}

    def do_reverse(self, db, data, actor):
        row = db.execute('SELECT * FROM entries WHERE id=?', (data.get('id'),)).fetchone()
        if not row or row['kind'] not in ('expense', 'income', 'transfer', 'legacy_expense'):
            raise Problem('仅能撤销手工支出、收入或转账')
        if db.execute('SELECT 1 FROM entries WHERE reverses=?', (row['id'],)).fetchone():
            raise Problem('该流水已撤销', 409)
        note = text(data.get('reason', ''))
        if not note:
            raise Problem('请填写撤销原因')
        posts = {p['pool']: -p['cents'] for p in db.execute('SELECT * FROM postings WHERE entry_id=?', (row['id'],))}
        identifier = self.post(db, row['date'], 'reversal', row['amount'], row['pool'], row['category'],
                               note, actor, posts, row['id'])
        if db.execute('SELECT 1 FROM settlements WHERE date=?', (row['date'],)).fetchone():
            self.settle(db, row['date'], actor)
        elif row['kind'] == 'expense' and row['pool'] == 'daily':
            self.rebalance_day(db, row['date'], actor)
        return {"id": identifier, "balances": self.balances(db)}

    def rebalance_day(self, db, d, actor):
        paid = db.execute("""SELECT COALESCE(SUM(-p.cents),0) FROM postings p JOIN entries e ON e.id=p.entry_id
            WHERE e.date=? AND p.pool='daily' AND (e.kind='coverage' OR (e.pool='daily' AND
            (e.kind='expense' OR (e.kind='reversal' AND e.reverses IN (SELECT id FROM entries WHERE kind='expense')))))""",(d,)).fetchone()[0]
        target = min(self.spent(db,d), self.rule(db,d)['daily_limit'], max(0,self.balances(db)['daily'] + paid))
        delta = target - paid
        if delta:
            self.post(db,d,'coverage',delta,'daily','','重新分配当日日常／灵活承担额',actor,{'daily':-delta,'flex':delta})

    def unsettle(self, db, d, actor):
        prior = db.execute('SELECT transferred FROM settlements WHERE date=?', (d,)).fetchone()
        if prior and prior[0]:
            self.post(db, d, 'settlement', -prior[0], 'flex', '', '重新计算已结算日', actor,
                      {'daily': prior[0], 'flex': -prior[0]})
            db.execute('UPDATE settlements SET transferred=0 WHERE date=?', (d,))

    def settle(self, db, d, actor):
        rule = self.rule(db, d)
        spent = self.spent(db, d)
        previous = db.execute('SELECT * FROM settlements WHERE date=?', (d,)).fetchone()
        old_transfer = previous['transferred'] if previous else 0
        anticipated = min(max(0,rule['daily_limit']-spent),max(0,self.balances(db)['daily']+old_transfer)) if rule['carry_over'] else 0
        if previous and previous['allowance']==rule['daily_limit'] and previous['spent']==spent and anticipated==old_transfer:
            return {'date':d,'allowance':rule['daily_limit'],'spent':spent,'transferred':old_transfer,'new_transfer':0}
        self.unsettle(db,d,actor)
        self.rebalance_day(db,d,actor)
        # Overspending is already covered by flex at purchase time. Never charge it twice.
        desired = min(max(0, rule['daily_limit'] - spent),
                      max(0, self.balances(db)['daily'])) if rule['carry_over'] else 0
        delta = desired - old_transfer
        if desired:
            self.post(db, d, 'settlement', desired, 'flex', '', '每日结算' if not previous else '重新计算每日结余',
                      actor, {'daily': -desired, 'flex': desired})
        db.execute('INSERT OR REPLACE INTO settlements VALUES(?,?,?,?)', (d, rule['daily_limit'], spent, desired))
        return {"date": d, "allowance": rule['daily_limit'], "spent": spent,
                "transferred": desired, "new_transfer": delta}

    def do_settle(self, db, data, actor):
        return self.settle(db, self.dated(db, data.get('date', self.today(db).isoformat())), actor)

    def do_settings(self, db, data, actor):
        cfg = self.settings(db)
        if data.get('revision') != cfg['revision']:
            raise Problem('设置已被其他会话修改，请刷新后再试', 409)
        effective = day(data.get('effective', self.today(db).isoformat()))
        if effective < self.today(db) or effective > self.today(db) + timedelta(days=366):
            raise Problem('额度规则只能从今天或未来一年内生效')
        old_rule = self.rule(db, effective.isoformat())
        rule = {"daily_limit": money(data.get('daily_limit', f"{old_rule['daily_limit']/100:.2f}")),
                "carry_over": data.get('carry_over', old_rule['carry_over'])}
        if not isinstance(rule['carry_over'], bool):
            raise Problem('结余划转开关必须为布尔值')
        review_day = data.get('review_day', cfg['review_day'])
        if type(review_day) is not int or not 1 <= review_day <= 28:
            raise Problem('月对账提醒日期须为 1–28 日')
        cfg.update(name=text(data.get('name', cfg['name']), 60),
                   settle_time=clock(data.get('settle_time', cfg['settle_time'])),
                   review_day=review_day, review_time=clock(data.get('review_time', cfg['review_time'])),
                   revision=cfg['revision'] + 1)
        db.execute("UPDATE meta SET value=? WHERE key='settings'", (pack(cfg),))
        db.execute('INSERT INTO rules(effective,data) VALUES(?,?)', (effective.isoformat(), pack(rule)))
        if db.execute('SELECT 1 FROM settlements WHERE date=?', (effective.isoformat(),)).fetchone():
            self.settle(db, effective.isoformat(), actor)
        self.audit(db, actor, 'settings', {"effective": effective.isoformat(), "settings": cfg, "rule": rule})
        return {"ok": True, "revision": cfg['revision']}

    def do_adjust(self, db, data, actor):
        target = pool(data.get('pool'))
        desired = money(data.get('balance'), signed=True)
        reason = text(data.get('reason', ''))
        if not reason:
            raise Problem('余额调整必须填写原因')
        delta = desired - self.balances(db)[target]
        identifier = self.post(db, self.today(db).isoformat(), 'adjustment', delta, target, '', reason,
                               actor, {target: delta, 'external': -delta})
        return {"id": identifier, "change": delta, "balances": self.balances(db)}

    def do_schedule(self, db, data, actor):
        identifier = data.get('id') or uuid.uuid4().hex
        if not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{32}', identifier):
            raise Problem('计划 ID 无效')
        existing = db.execute('SELECT data FROM schedules WHERE id=?', (identifier,)).fetchone()
        if data.get('id') and not existing:
            raise Problem('计划不存在', 404)
        frequency = data.get('frequency', 'monthly')
        n = data.get('day', 1)
        if frequency not in ('daily', 'monthly') or type(n) is not int or not 1 <= n <= 31:
            raise Problem('计划频率或日期无效')
        enabled = data.get('enabled', True)
        if not isinstance(enabled, bool):
            raise Problem('启用值须为布尔值')
        info = {"name": text(data.get('name', '定期入账'), 60), "pool": pool(data.get('pool', 'daily')),
                "amount": money(data.get('amount')), "frequency": frequency, "day": n,
                "time": clock(data.get('time', '09:00')), "enabled": enabled,
                "start_date": self.today(db).isoformat()}
        # Changing a recurring rule applies going forward, never rewrites old credits.
        db.execute('INSERT OR REPLACE INTO schedules VALUES(?,?,?)', (identifier, pack(info), self.stamp()))
        self.audit(db, actor, 'schedule', {"id": identifier, **info})
        return {"id": identifier}

    def do_review(self, db, data, actor):
        period = text(data.get('period', ''), 10)
        if re.fullmatch(r'\d{4}-\d{2}', period):
            first = day(period + '-01')
            end = first.replace(day=calendar.monthrange(first.year, first.month)[1])
        else:
            end = day(period)
        today = self.today(db)
        if end > today:
            raise Problem('对账周期尚未结束；当天请使用每日对账')
        self.dated(db, end.isoformat())
        expected = self.balances(db, end.isoformat())
        raw = data.get('actual')
        if not isinstance(raw, dict) or set(raw) != set(POOLS):
            raise Problem('请填写三个资金池的实核金额')
        actual = {k: money(raw[k], signed=True) for k in POOLS}
        diff = {k: actual[k] - expected[k] for k in POOLS}
        identifier = uuid.uuid4().hex
        db.execute('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?,?)', (identifier, period, end.isoformat(),
                   pack(expected), pack(actual), pack(diff), text(data.get('note', '')), actor, self.stamp()))
        self.audit(db, actor, 'review', {"id": identifier, "period": period, "difference": diff})
        return {"id": identifier, "difference": diff, "matched": not any(diff.values())}

    def tick(self):
        """Replay due events in order; each credit/settlement is atomic and idempotent."""
        with self.transaction() as db:
            if not self.initialized(db):
                return
            cfg = self.settings(db)
            now = self.now().astimezone(ZoneInfo(cfg['timezone']))
            start = day(cfg['start_date'])
            if (now.date() - start).days > 36600:
                raise Problem('账本日期超出支持范围')
            schedules = [(r['id'], json.loads(r['data'])) for r in db.execute('SELECT * FROM schedules')]
            # Completed dates are already adjusted synchronously on late writes.
            closed = {r[0] for r in db.execute('SELECT date FROM settlements')}
            credits = {(r[0], r[1]) for r in db.execute('SELECT schedule_id,date FROM schedule_runs')}
            d = start
            while d <= now.date():
                ds = d.isoformat()
                events = []
                for identifier, sc in schedules:
                    due_day = min(sc['day'], calendar.monthrange(d.year, d.month)[1])
                    if sc['enabled'] and ds >= sc['start_date'] and (sc['frequency'] == 'daily' or d.day == due_day):
                        events.append((sc['time'], 'credit', identifier, sc))
                events.append((cfg['settle_time'], 'settle', '', {}))
                for hhmm, kind, identifier, sc in sorted(events, key=lambda e: (e[0], e[1])):
                    if datetime.combine(d, time.fromisoformat(hhmm), now.tzinfo) > now:
                        continue
                    if kind == 'credit' and (identifier, ds) not in credits:
                        eid = self.post(db, ds, 'scheduled_income', sc['amount'], sc['pool'], '', sc['name'],
                                        'scheduler', {sc['pool']: sc['amount'], 'external': -sc['amount']})
                        db.execute('INSERT INTO schedule_runs VALUES(?,?,?)', (identifier, ds, eid))
                    elif kind == 'settle' and ds not in closed:
                        self.settle(db, ds, 'scheduler')
                if d.day == cfg['review_day'] and datetime.combine(d, time.fromisoformat(cfg['review_time']), now.tzinfo) <= now:
                    period = (d.replace(day=1) - timedelta(days=1)).strftime('%Y-%m')
                    if period >= cfg['start_date'][:7]:
                        db.execute('INSERT OR IGNORE INTO review_due VALUES(?,?)', (period, self.stamp()))
                d += timedelta(days=1)
            db.execute("INSERT OR REPLACE INTO meta VALUES('last_tick',?)", (self.stamp(),))
            self.check_bankruptcy(db)

    def dashboard(self):
        with self.connect() as db:
            if not self.initialized(db):
                return {"initialized": False}
            cfg = self.settings(db)
            today = self.today(db)
            ds = today.isoformat()
            rule = self.rule(db, ds)
            spent = self.spent(db, ds)
            totals = self.balances(db)
            spent_assets = db.execute("""SELECT COALESCE(SUM(-p.cents),0) FROM postings p JOIN entries e ON p.entry_id=e.id
                WHERE p.pool IN ('daily','flex') AND (e.kind='expense' OR
                (e.kind='reversal' AND e.reverses IN (SELECT id FROM entries WHERE kind='expense')))""").fetchone()[0]
            month = ds[:7]
            rows = db.execute("""SELECT e.kind,COALESCE(SUM(p.cents),0) AS change FROM entries e
                JOIN postings p ON p.entry_id=e.id WHERE e.date LIKE ? AND p.pool='external' GROUP BY e.kind""",
                (month + '%',)).fetchall()
            changes = {r['kind']: r['change'] for r in rows}
            trend = []
            for n in range(6, -1, -1):
                d = (today - timedelta(days=n)).isoformat()
                trend.append({"date": d, "spent": self.spent(db, d), "limit": self.rule(db, d)['daily_limit']})
            pending = [r[0] for r in db.execute('SELECT period FROM review_due WHERE period NOT IN (SELECT period FROM reviews) ORDER BY period')]
            last = db.execute("SELECT value FROM meta WHERE key='last_tick'").fetchone()
            return {"initialized": True, "legacy_count": db.execute("SELECT COUNT(*) FROM entries WHERE kind='legacy_expense'").fetchone()[0], "today": ds, "settings": cfg, "rule": rule, "balances": totals,
                    "spent": spent, "remaining": rule['daily_limit'] - spent,
                    "usage_percent": round(spent / rule['daily_limit'] * 100, 1) if rule['daily_limit'] else None,
                    "settled": db.execute('SELECT 1 FROM settlements WHERE date=?', (ds,)).fetchone() is not None,
                    "next_reset": datetime.combine(today + timedelta(days=1), time(), ZoneInfo(cfg['timezone'])).isoformat(),
                    "projected_carry": min(max(0, rule['daily_limit'] - spent), max(0, totals['daily'])) if rule['carry_over'] else 0,
                    "bankrupt": totals['daily'] + totals['flex'] <= 0,
                    "spendable": totals['daily'] + totals['flex'],
                    "spendable_capacity": max(0, totals['daily'] + totals['flex'] + spent_assets),
                    "deficit": max(0, -totals['daily'] - totals['flex']),
                    "month_expense": db.execute("SELECT COALESCE(SUM(amount),0) FROM entries e WHERE kind='legacy_expense' AND date LIKE ? AND NOT EXISTS(SELECT 1 FROM entries r WHERE r.reverses=e.id)",(month+'%',)).fetchone()[0] + changes.get('expense', 0) + db.execute("""SELECT COALESCE(SUM(p.cents),0) FROM entries e
                       JOIN postings p ON e.id=p.entry_id WHERE p.pool='external' AND e.date LIKE ? AND e.kind='reversal'
                       AND e.reverses IN (SELECT id FROM entries WHERE kind='expense')""", (month+'%',)).fetchone()[0],
                    "month_income": -changes.get('income', 0) - changes.get('scheduled_income', 0) + db.execute("""SELECT -COALESCE(SUM(p.cents),0)
                       FROM entries e JOIN postings p ON e.id=p.entry_id WHERE p.pool='external' AND e.date LIKE ? AND e.kind='reversal'
                       AND e.reverses IN (SELECT id FROM entries WHERE kind='income')""", (month+'%',)).fetchone()[0],
                    "trend": trend, "pending_reviews": pending, "last_tick": last[0] if last else None,
                    "warnings": [f'{k} 资金池出现赤字，请核对或重新分配' for k, v in totals.items() if v < 0]}

    def entries(self, start=None, end=None, limit=100, offset=0):
        where, args = [], []
        if start:
            where.append('e.date>=?'); args.append(day(start).isoformat())
        if end:
            where.append('e.date<=?'); args.append(day(end).isoformat())
        sql = ' WHERE ' + ' AND '.join(where) if where else ''
        with self.connect() as db:
            count = db.execute('SELECT COUNT(*) FROM entries e' + sql, args).fetchone()[0]
            rows = db.execute('SELECT e.*,EXISTS(SELECT 1 FROM entries r WHERE r.reverses=e.id) AS reversed FROM entries e' + sql +
                              ' ORDER BY e.date DESC,e.rowid DESC LIMIT ? OFFSET ?', (*args, min(max(limit,1),1000), max(offset,0))).fetchall()
            items = []
            for r in rows:
                item = dict(r)
                item['postings'] = {p['pool']:p['cents'] for p in db.execute('SELECT pool,cents FROM postings WHERE entry_id=?',(r['id'],))}
                items.append(item)
            return {"total": count, "items": items}

    def notifications(self):
        with self.connect() as db:
            return [{**dict(r), 'data':json.loads(r['data'])} for r in db.execute(
                'SELECT * FROM notifications WHERE acknowledged_at IS NULL ORDER BY created_at LIMIT 100')]

    def do_ack(self, db, data, actor):
        row = db.execute('SELECT id FROM notifications WHERE id=?', (data.get('id'),)).fetchone()
        if not row:
            raise Problem('通知不存在',404)
        db.execute('UPDATE notifications SET acknowledged_by=?,acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL',
                   (actor,self.stamp(),row['id']))
        self.audit(db,actor,'notification_ack',{'id':row['id']})
        return {'ok':True}

    def list_schedules(self):
        with self.connect() as db:
            return [{"id": r['id'], **json.loads(r['data'])} for r in db.execute('SELECT * FROM schedules ORDER BY created_at')]

    def list_reviews(self):
        with self.connect() as db:
            items = []
            for r in db.execute('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 100'):
                item = dict(r)
                for k in ('expected', 'actual', 'difference'):
                    item[k] = json.loads(item[k])
                # Later backdated writes can invalidate an earlier comparison; show this explicitly.
                item['stale'] = self.balances(db, item['date']) != item['expected']
                items.append(item)
            return items

    def summary(self, period):
        with self.connect() as db:
            if re.fullmatch(r'\d{4}-\d{2}', period):
                first = day(period+'-01'); last = first.replace(day=calendar.monthrange(first.year,first.month)[1])
            else:
                first = last = day(period)
            self.dated(db, last.isoformat())
            return {"period": period, "expected": self.balances(db, last.isoformat()),
                    "settlements": [dict(r) for r in db.execute('SELECT * FROM settlements WHERE date BETWEEN ? AND ? ORDER BY date',
                                     (first.isoformat(), last.isoformat()))]}
