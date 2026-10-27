import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

from pocketquota.server import App, Handler


class HTTPTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        cls.port=cls.server.server_address[1]
        cls.base=f'http://127.0.0.1:{cls.port}'
        cls.app=App(cls.tmp.name,cls.port)
        cls.server.app=cls.app
        cls.owner=(Path(cls.tmp.name)/'admin.token').read_text().strip()
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.request('/api/setup',{'daily':'100.00','flex':'50.00','reserve':'100.00'},token=cls.owner)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join();cls.tmp.cleanup()

    @classmethod
    def request(cls,path,body=None,token=None,headers=None):
        hs={'Content-Type':'application/json','Idempotency-Key':uuid.uuid4().hex,**(headers or {})}
        if token:hs['Authorization']='Bearer '+token
        req=urllib.request.Request(cls.base+path,data=json.dumps(body).encode() if body is not None else None,headers=hs)
        try:r=urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req)
        except urllib.error.HTTPError as e:r=e
        with r:
            raw=r.read();data=json.loads(raw) if r.headers.get('Content-Type','').startswith('application/json') else raw
            return r.status,data,r.headers

    def test_private_api_requires_auth(self):
        self.assertEqual(self.request('/api/dashboard')[0],401)
        self.assertEqual(self.request('/api/export.csv')[0],401)

    def test_origin_and_host_rejected(self):
        self.assertEqual(self.request('/api/dashboard',token=self.owner,headers={'Origin':'https://evil.example'})[0],403)
        self.assertEqual(self.request('/api/dashboard',token=self.owner,headers={'Host':'evil.example'})[0],403)

    def test_scoped_token_and_revocation(self):
        status,t,_=self.request('/api/tokens',{'name':'Readonly test','scopes':['read']},self.owner)
        self.assertEqual(status,201)
        self.assertEqual(self.request('/api/dashboard',token=t['token'])[0],200)
        self.assertEqual(self.request('/api/entries',{'amount':'1.00'},t['token'])[0],403)
        self.request('/api/tokens/revoke',{'id':t['id']},self.owner)
        self.assertEqual(self.request('/api/dashboard',token=t['token'])[0],401)

    def test_writer_cannot_modify_budget_or_tokens(self):
        _,t,_=self.request('/api/tokens',{'name':'Writer test','scopes':['read','write']},self.owner)
        self.assertEqual(self.request('/api/settings',{'revision':1,'daily_limit':'1000.00'},t['token'])[0],403)
        self.assertEqual(self.request('/api/tokens',{'name':'More'},t['token'])[0],403)
        self.assertEqual(self.request('/api/adjust',{'pool':'daily','balance':'999.00','reason':'no'},t['token'])[0],403)
        self.assertEqual(self.request('/api/entries',{'amount':'1.00'},t['token'])[0],200)

    def test_manage_scope_is_not_owner_scope(self):
        _,t,_=self.request('/api/tokens',{'name':'Manager test','scopes':['read','write','manage']},self.owner)
        _,dashboard,_=self.request('/api/dashboard',token=t['token'])
        revision=dashboard['settings']['revision']
        self.assertEqual(self.request('/api/settings',{'revision':revision,'daily_limit':'61.00'},t['token'])[0],200)
        self.assertEqual(self.request('/api/tokens',{'name':'Escalate'},t['token'])[0],403)
        self.assertEqual(self.request('/api/tokens/revoke',{'id':t['id']},t['token'])[0],403)

    def test_openapi_and_guide_are_credential_free(self):
        from pocketquota.mcp import TOOLS
        status,spec,_=self.request('/openapi.json')
        self.assertEqual(status,200)
        names={o['operationId'] for methods in spec['paths'].values() for o in methods.values()}
        self.assertEqual(names,{t['name'] for t in TOOLS})
        status,html,headers=self.request('/guide.html')
        self.assertEqual(status,200)
        self.assertEqual(len(headers.get_all('Content-Security-Policy')),1)
        self.assertIn("style-src 'sha256-",headers['Content-Security-Policy'])
        self.assertNotIn(self.owner.encode(),html)

    def test_cookie_session_csrf_and_logout(self):
        status,data,hs=self.request('/api/login',{'token':self.owner},headers={'Origin':self.base})
        self.assertEqual(status,200)
        cookie=hs['Set-Cookie'].split(';')[0]
        self.assertIn('HttpOnly',hs['Set-Cookie'])
        self.assertIn('SameSite=Strict',hs['Set-Cookie'])
        self.assertEqual(self.request('/api/entries',{'amount':'1.00'},headers={'Cookie':cookie,'Origin':self.base})[0],403)
        valid={'Cookie':cookie,'Origin':self.base,'X-CSRF-Token':data['csrf']}
        self.assertEqual(self.request('/api/entries',{'amount':'1.00'},headers=valid)[0],200)
        self.assertEqual(self.request('/api/logout',{},headers=valid)[0],200)
        self.assertEqual(self.request('/api/dashboard',headers={'Cookie':cookie})[0],401)

    def test_csv_formula_neutralized(self):
        self.request('/api/entries',{'amount':'1.00','note':'=1+1'},self.owner)
        status,raw,_=self.request('/api/export.csv',token=self.owner)
        self.assertEqual(status,200)
        self.assertIn("'=1+1",raw.decode('utf-8-sig'))
        self.assertTrue(raw.startswith(b'\xef\xbb\xbf'))
        self.assertIn('金额（元）',raw.decode('utf-8-sig'))
        status,raw,_=self.request('/api/export.csv?start=2000-01-01&end=2000-01-02',token=self.owner)
        self.assertEqual(status,200)
        self.assertEqual(len(raw.decode('utf-8-sig').splitlines()),1)

    def test_mcp_end_to_end_and_idempotency(self):
        _,token,_=self.request('/api/tokens',{'name':'MCP test','scopes':['read','write']},self.owner)
        calls=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'test','version':'1'}}},
               {'jsonrpc':'2.0','method':'notifications/initialized'},
               {'jsonrpc':'2.0','id':2,'method':'tools/list'},
               {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'budget_status','arguments':{}}}]
        key=uuid.uuid4().hex
        for i in (4,5):calls.append({'jsonrpc':'2.0','id':i,'method':'tools/call','params':{'name':'budget_record','arguments':{'amount':'2.34','request_id':key}}})
        env={**os.environ,'POCKETQUOTA_URL':self.base,'POCKETQUOTA_TOKEN':token['token']}
        r=subprocess.run([sys.executable,'-m','pocketquota.mcp'],input=''.join(json.dumps(c)+'\n' for c in calls),text=True,capture_output=True,env=env,timeout=20)
        self.assertEqual(r.returncode,0)
        values=[json.loads(x) for x in r.stdout.splitlines()]
        self.assertEqual(len(values),5)
        self.assertEqual(values[0]['result']['protocolVersion'],'2025-06-18')
        self.assertEqual(len(values[1]['result']['tools']),13)

        self.assertFalse(values[2]['result']['isError'])
        self.assertEqual(values[3]['result']['content'],values[4]['result']['content'])

    def test_notification_api_empty_and_schema(self):
        status,data,_=self.request('/api/notifications',token=self.owner)
        self.assertEqual(status,200)
        self.assertIsInstance(data,list)

    def test_static_csp_and_no_external_assets(self):
        status,raw,headers=self.request('/')
        self.assertEqual(status,200)
        self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])
        self.assertNotIn(b'https://',raw)


if __name__=='__main__':unittest.main()
