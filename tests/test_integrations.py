"""Synthetic adapter tests: no real account, network or personal ledger."""
import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('harness_bridge', Path(__file__).parents[1]/'integrations/harness_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class HarnessBridgeTest(unittest.TestCase):
    def test_uses_shared_secure_mcp_transport(self):
        with patch.object(bridge, 'call', return_value={'ok':True}) as call:
            self.assertEqual(asyncio.run(bridge.request('/api/entries', {'amount':'1.00'}, 'stable-event-123')), {'ok':True})
            call.assert_called_once_with('budget_record', {'amount':'1.00', 'request_id':'stable-event-123'})
        with self.assertRaises(ValueError):
            asyncio.run(bridge.request('/api/users', {'username':'unwanted'}))

    def test_retries_keep_same_key_even_if_arguments_changed(self):
        keys=[]
        async def fake(path, payload=None, key=None):
            keys.append(key)
            self.assertEqual(payload['pool'], 'daily')
            return {'id':'synthetic'}
        with patch.object(bridge, 'request', side_effect=fake), patch.dict('os.environ', {'POCKETQUOTA_LEGACY_CONFIG':''}):
            for amount in ('1.00','2.00'):
                asyncio.run(bridge.invoke({'name':'bookkeeper_add_expense','source_id':'test-message',
                                           'args':{'amount':amount,'item':'交通'}}))
        self.assertEqual(keys[0],keys[1])  # Server rejects changed contents under the same event key.

    def test_missing_event_never_writes(self):
        with patch.object(bridge, 'call') as call, self.assertRaises(ValueError):
            asyncio.run(bridge.invoke({'name':'bookkeeper_add_expense','args':{'amount':'1.00'}}))
        call.assert_not_called()

    def test_calendar_uses_account_today(self):
        paths=[]
        async def fake(path, payload=None, key=None):
            paths.append(path)
            if path == '/api/dashboard':return {'today':'2030-01-02'}
            return {'total':0,'items':[]}
        with patch.object(bridge, 'request', side_effect=fake):
            self.assertEqual(asyncio.run(bridge.records({'scope':'today'})), [])
        self.assertIn('start=2030-01-02',paths[1])
