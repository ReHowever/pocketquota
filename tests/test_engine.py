import concurrent.futures
import json
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pocketquota.engine import Ledger, Problem, money


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = datetime(2026,1,30,4,tzinfo=timezone.utc)
        self.ledger = Ledger(Path(self.temp.name)/'ledger.db',lambda:self.now)
        self.write('setup', {'daily':'180.00','flex':'100.00','reserve':'500.00','daily_limit':'60.00'})

    def tearDown(self):
        self.temp.cleanup()

    def write(self,op,data,key=None):
        return self.ledger.mutate(op,data,'test',key or uuid.uuid4().hex)

    def balances(self):
        return self.ledger.dashboard()['balances']

    def assertBalanced(self):
        with self.ledger.connect() as db:
            bad=db.execute('SELECT entry_id FROM postings GROUP BY entry_id HAVING SUM(cents)!=0').fetchall()
            self.assertEqual(bad,[])

    def test_money_rejects_rounding_and_floats(self):
        self.assertEqual(money('0.29'),29)
        for value in [1.23,'1.239','NaN','1e3',None,True,'-1']:
            with self.subTest(value=value),self.assertRaises(Problem):money(value)

    def test_daily_surplus_conserves_money(self):
        self.write('entry',{'amount':'25.00'})
        self.write('settle',{})
        self.assertEqual(self.balances(),{'daily':12000,'flex':13500,'reserve':50000})
        self.assertBalanced()

    def test_daily_limit_excess_immediately_uses_flex(self):
        result=self.write('entry',{'amount':'75.00'})
        self.assertEqual(result['allocation'],{'daily':6000,'flex':1500})
        self.assertEqual(self.balances()['flex'],8500)
        self.write('settle',{})
        self.assertEqual(self.balances()['flex'],8500)

    def test_insufficient_daily_pool_uses_flex(self):
        self.write('adjust',{'pool':'daily','balance':'10.00','reason':'test'})
        result=self.write('entry',{'amount':'25.00'})
        self.assertEqual(result['allocation'],{'daily':1000,'flex':1500})
        self.write('settle',{})
        self.assertEqual(self.balances()['daily'],0)
        self.assertEqual(self.balances()['flex'],8500)

    def test_explicit_flex_not_in_daily_usage(self):
        self.write('entry',{'amount':'23.45','pool':'flex'})
        self.assertEqual(self.ledger.dashboard()['spent'],0)
        self.assertEqual(self.balances()['flex'],7655)

    def test_idempotency_and_conflict(self):
        a=self.write('entry',{'amount':'10.00'},'request-001')
        b=self.write('entry',{'amount':'10.00'},'request-001')
        self.assertEqual(a,b)
        self.assertEqual(self.ledger.dashboard()['spent'],1000)
        with self.assertRaises(Problem):self.write('entry',{'amount':'20.00'},'request-001')

    def test_concurrent_duplicate_is_once(self):
        def work(_):return self.write('entry',{'amount':'5.00'},'parallel-001')
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            result=list(executor.map(work,range(12)))
        self.assertEqual(len({r['id'] for r in result}),1)
        self.assertEqual(self.ledger.dashboard()['spent'],500)

    def test_late_expense_corrects_settlement(self):
        self.write('entry',{'amount':'25.00'})
        self.write('settle',{})
        self.write('entry',{'amount':'10.00'})
        self.assertEqual(self.balances()['daily'],12000)
        self.assertEqual(self.balances()['flex'],12500)
        self.assertBalanced()

    def test_late_expense_over_limit_no_double_charge(self):
        self.write('entry',{'amount':'25.00'})
        self.write('settle',{})
        self.write('entry',{'amount':'50.00'})
        self.assertEqual(self.balances()['daily'],12000)
        self.assertEqual(self.balances()['flex'],8500)

    def test_reversal_reallocates_flex_coverage(self):
        first=self.write('entry',{'amount':'50.00'})
        self.write('entry',{'amount':'20.00'})
        self.write('settle',{})
        self.write('reverse',{'id':first['id'],'reason':'duplicate'})
        self.assertEqual(self.balances()['daily'],12000)
        self.assertEqual(self.balances()['flex'],14000)
        self.assertEqual(self.ledger.dashboard()['month_expense'],2000)
        with self.assertRaises(Problem):self.write('reverse',{'id':first['id'],'reason':'twice'})

    def test_repeated_settlement_never_changes_balances(self):
        self.write('entry',{'amount':'12.34'})
        self.write('settle',{})
        before=self.balances()
        before_count=self.ledger.entries()['total']
        for _ in range(3):self.write('settle',{})
        self.assertEqual(self.balances(),before)
        self.assertEqual(self.ledger.entries()['total'],before_count)

    def test_concurrent_different_expenses_do_not_lose_updates(self):
        def work(_):return self.write('entry',{'amount':'3.01'})
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            list(executor.map(work,range(30)))
        self.assertEqual(self.ledger.dashboard()['spent'],9030)
        self.assertEqual(self.balances(),{'daily':12000,'flex':6970,'reserve':50000})
        self.assertBalanced()

    def test_changing_settled_limit_reallocates_without_creating_money(self):
        self.write('entry',{'amount':'50.00'})
        self.write('settle',{})
        before=sum(self.balances().values())
        self.write('settings',{'revision':1,'daily_limit':'30.00'})
        self.assertEqual(self.balances(),{'daily':15000,'flex':8000,'reserve':50000})
        self.assertEqual(sum(self.balances().values()),before)

    def test_capacity_only_increases_when_funded(self):
        before=self.ledger.dashboard()['spendable_capacity']
        self.write('entry',{'amount':'10.00'})
        self.assertEqual(self.ledger.dashboard()['spendable_capacity'],before)
        self.write('entry',{'kind':'income','amount':'25.00','pool':'flex'})
        self.assertEqual(self.ledger.dashboard()['spendable_capacity'],before+2500)
        self.assertEqual(self.ledger.dashboard()['rule']['daily_limit'],6000)

    def test_carry_off_keeps_daily_money(self):
        self.write('settings',{'revision':1,'carry_over':False})
        self.write('entry',{'amount':'20.00'})
        self.write('settle',{})
        self.assertEqual(self.balances()['daily'],16000)
        self.assertEqual(self.balances()['flex'],10000)

    def test_rule_history_and_conflict(self):
        self.write('settings',{'revision':1,'daily_limit':'30.00','effective':'2026-01-31'})
        self.assertEqual(self.ledger.dashboard()['rule']['daily_limit'],6000)
        self.now+=timedelta(days=1)
        self.assertEqual(self.ledger.dashboard()['rule']['daily_limit'],3000)
        with self.assertRaises(Problem):self.write('settings',{'revision':1,'daily_limit':'20.00'})
        with self.assertRaises(Problem):self.write('settings',{'revision':2,'effective':'2026-01-29'})

    def test_monthly_short_month_and_offline_replay(self):
        self.write('schedule',{'name':'Allowance','amount':'100.00','pool':'daily','day':31,'time':'09:00'})
        self.now=datetime(2026,3,1,4,tzinfo=timezone.utc)
        self.ledger.tick();self.ledger.tick()
        with self.ledger.connect() as db:
            rows=db.execute('SELECT date FROM schedule_runs ORDER BY date').fetchall()
        self.assertEqual([r[0] for r in rows],['2026-01-31','2026-02-28'])
        self.assertBalanced()

    def test_schedule_edit_does_not_duplicate_today(self):
        s=self.write('schedule',{'amount':'10.00','frequency':'daily','time':'09:00'})
        self.ledger.tick()
        self.write('schedule',{'id':s['id'],'amount':'20.00','frequency':'daily','time':'09:00'})
        self.ledger.tick()
        with self.ledger.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM schedule_runs').fetchone()[0],1)

    def test_failure_rolls_back(self):
        before=self.balances()
        with self.assertRaises(Problem):self.write('entry',{'kind':'transfer','pool':'daily','to_pool':'daily','amount':'10.00'})
        self.assertEqual(self.balances(),before)

    def test_reconciliation_does_not_invent_money(self):
        r=self.write('review',{'period':'2026-01-30','actual':{'daily':'170.00','flex':'100.00','reserve':'500.00'}})
        self.assertEqual(r['difference']['daily'],-1000)
        self.assertEqual(self.balances()['daily'],18000)
        self.write('entry',{'amount':'5.00'})
        self.assertTrue(self.ledger.list_reviews()[0]['stale'])

    def test_bankruptcy_event_once_and_recovers(self):
        self.write('entry',{'amount':'300.00'})
        d=self.ledger.dashboard()
        self.assertTrue(d['bankrupt'])
        self.assertEqual(d['deficit'],2000)
        self.assertEqual(d['balances']['reserve'],50000)
        self.write('entry',{'amount':'5.00'})
        self.ledger.tick()
        self.assertEqual(len(self.ledger.notifications()),1)
        event=self.ledger.notifications()[0]
        self.write('ack',{'id':event['id']})
        self.assertEqual(self.ledger.notifications(),[])
        self.write('entry',{'kind':'income','amount':'100.00','pool':'flex'})
        self.assertFalse(self.ledger.dashboard()['bankrupt'])
        self.write('entry',{'amount':'100.00'})
        self.assertEqual(len(self.ledger.notifications()),1)

    def test_all_dates_and_pool_inputs_validated(self):
        for data in [{'amount':'5.00','date':'2026-02-01'},{'amount':'5.00','date':'2026-01-01'},{'amount':'5.00','pool':'external'}]:
            with self.assertRaises(Problem):self.write('entry',data)

    def test_income_reverse_and_transfer_conserve_total(self):
        r=self.write('entry',{'kind':'income','amount':'30.00','pool':'flex'})
        self.write('reverse',{'id':r['id'],'reason':'mistake'})
        self.assertEqual(self.ledger.dashboard()['month_income'],0)
        before=sum(self.balances().values())
        self.write('entry',{'kind':'transfer','amount':'25.00','pool':'flex','to_pool':'daily'})
        self.assertEqual(sum(self.balances().values()),before)


if __name__=='__main__':unittest.main()
