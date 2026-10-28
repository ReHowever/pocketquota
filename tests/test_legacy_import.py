import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timezone
from pocketquota.engine import Ledger, Problem
from pocketquota.import_legacy import import_records


class LegacyImportTest(unittest.TestCase):
    def test_history_is_lossless_idempotent_and_does_not_debit_confirmed_balances(self):
        with tempfile.TemporaryDirectory() as d:
            ledger=Ledger(Path(d)/'ledger.db', lambda:datetime(2026,10,28,4,tzinfo=timezone.utc))
            ledger.mutate('setup',{'daily':'123.45','flex':'67.89','reserve':'400','daily_limit':'40'},'test','setup-legacy-test')
            rows=[{'record_id':'old-1','date':'2026-10-27','item':'零食','amount':5.5,'note':'','timestamp':123,'source_message_id':'m1'}]
            before=ledger.dashboard()['balances']
            self.assertEqual(import_records(ledger,rows)['added'],1)
            self.assertEqual(import_records(ledger,rows)['added'],0)
            self.assertEqual(ledger.dashboard()['balances'],before)
            with ledger.connect() as db:
                self.assertEqual(db.execute('SELECT amount FROM entries WHERE kind="legacy_expense"').fetchone()[0],550)
                self.assertIn('source_message_id',db.execute('SELECT raw FROM legacy_records').fetchone()[0])
            rows[0]['amount']=6
            with self.assertRaises(Problem):import_records(ledger,rows)
            self.assertEqual(ledger.dashboard()['balances'],before)

    def ledger(self, directory):
        ledger=Ledger(Path(directory)/'ledger.db',lambda:datetime(2030,1,15,4,tzinfo=timezone.utc))
        ledger.mutate('setup',{'daily':'100','flex':'20','reserve':'40'},'test','synthetic-setup-id')
        return ledger

    def test_month_total_reversal_and_raw_archive_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            ledger=self.ledger(d)
            row={'record_id':'synthetic-old','date':'2030-01-14','amount':'12.34','item':'餐饮'}
            import_records(ledger,[row])
            before=ledger.dashboard()['balances']
            self.assertEqual(ledger.dashboard()['month_expense'],1234)
            identifier=ledger.entries()['items'][0]['id']
            # Select by kind instead of ordering alongside the opening rows.
            identifier=next(x['id'] for x in ledger.entries()['items'] if x['kind']=='legacy_expense')
            ledger.mutate('reverse',{'id':identifier,'reason':'修正历史归档'},'test','synthetic-reverse-id')
            self.assertEqual(ledger.dashboard()['month_expense'],0)
            self.assertEqual(ledger.dashboard()['balances'],before)
            self.assertEqual(import_records(ledger,[row])['added'],0)
            with ledger.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM legacy_records').fetchone()[0],1)

    def test_invalid_batch_rolls_back_precision_dates_and_snapshot(self):
        for invalid in [dict(amount='1.001'),dict(date='2030-01-15'),dict(pool='unknown')]:
            with self.subTest(invalid=invalid),tempfile.TemporaryDirectory() as d:
                ledger=self.ledger(d)
                good={'record_id':'good','date':'2030-01-14','amount':'1.00'}
                bad={**good,'record_id':'bad',**invalid}
                with self.assertRaises(Problem):import_records(ledger,[good,bad])
                self.assertEqual(ledger.dashboard()['legacy_count'],0)
        with tempfile.TemporaryDirectory() as d:
            ledger=self.ledger(d)
            import_records(ledger,[],{'currency':'CNY'})
            with self.assertRaises(Problem):import_records(ledger,[],{'currency':'USD'})
