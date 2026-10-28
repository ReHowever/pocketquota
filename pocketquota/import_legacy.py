"""Offline, idempotent preservation of pre-cutover bookkeeping; never re-debit balances."""
import hashlib
import json
from .engine import day, pack, money, pool, Problem


def import_records(ledger, records, budget_snapshot=None):
    with ledger.transaction() as db:
        ledger.settings(db)
        db.execute('CREATE TABLE IF NOT EXISTS legacy_records(source_id TEXT PRIMARY KEY, entry_id TEXT UNIQUE, raw TEXT NOT NULL)')
        added = 0
        for r in records:
            source_id = str(r['record_id'])
            if not source_id or len(source_id) > 240:
                raise Problem('Invalid legacy record identifier')
            raw = pack(r)
            existing = db.execute('SELECT raw FROM legacy_records WHERE source_id=?', (source_id,)).fetchone()
            if existing:
                if existing[0] != raw:
                    raise Problem('Legacy record changed; reconcile explicitly: '+source_id, 409)
                continue
            d = day(r['date']).isoformat()
            if d >= ledger.settings(db)['start_date']:
                raise Problem('Cutover-day records must use live accounting, not historical import')
            amount = money(str(r['amount']))
            if amount <= 0:
                raise Problem('Legacy amount must be positive')
            eid = 'legacy-' + hashlib.sha256(source_id.encode()).hexdigest()[:32]
            note = str(r.get('item', '')) + (' · '+str(r['note']) if r.get('note') else '')
            target = pool(r.get('pool', 'daily'))
            db.execute('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (eid,d,'legacy_expense',amount,target,str(r.get('item','')),note,
                        'Harness/Luma 历史迁入',str(r.get('timestamp','')),None))
            db.execute('INSERT INTO legacy_records VALUES(?,?,?)', (source_id,eid,raw))
            added += 1
        if budget_snapshot is not None:
            previous = db.execute("SELECT value FROM meta WHERE key='legacy_budget_snapshot'").fetchone()
            if previous and previous[0] != pack(budget_snapshot):
                raise Problem('Legacy budget snapshot changed; reconcile explicitly', 409)
            db.execute("INSERT OR IGNORE INTO meta VALUES('legacy_budget_snapshot',?)", (pack(budget_snapshot),))
        ledger.audit(db,'migration','legacy_import',{'added':added,'source_count':len(records),'balance_effect':0})
        return {'added':added,'source_count':len(records),'balance_effect':0}
