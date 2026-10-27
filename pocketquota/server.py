"""Self-hosted HTTP API and same-origin UI, no third-party runtime dependencies."""
import argparse
import base64
import csv
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .engine import Ledger, Problem, POOLS, pack, text, day

STATIC = Path(__file__).parent / 'static'


def digest(secret):
    return hashlib.sha256(secret.encode()).hexdigest()


class App:
    def __init__(self, data, port=18790, demo=False, origin=None):
        self.data = Path(data)
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.ledger = Ledger(self.data / 'ledger.sqlite3')
        key = self.data / 'admin.token'
        if not key.exists():
            fd = os.open(key, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(secrets.token_urlsafe(36) + '\n')
        self.owner_digest = digest(key.read_text().strip())
        self.demo = demo
        self.origin = origin
        self.origins = {origin} if origin else {f'http://localhost:{port}', f'http://127.0.0.1:{port}'}
        self.hosts = {urlsplit(o).netloc for o in self.origins}
        self.sessions, self.attempts = {}, {}
        self.lock = threading.Lock()
        self.stop = threading.Event()
        if demo:
            with self.ledger.connect() as db:
                initialized = self.ledger.initialized(db)
            if not initialized:
                self.ledger.mutate('setup', {'name': '我的生活额度 · 演示', 'daily_limit': '60.00',
                    'daily': '1800.00', 'flex': '360.00', 'reserve': '1000.00'}, 'demo', 'demo-setup-v1')
                for i, (amount, category, note, pool) in enumerate([
                    ('12.00', '餐饮', '晨间咖啡与面包', 'daily'),
                    ('18.50', '餐饮', '午餐', 'daily'), ('8.00', '交通', '周末出行', 'flex')]):
                    self.ledger.mutate('entry', dict(amount=amount, category=category, note=note, pool=pool), 'demo', f'demo-entry-{i}')
                self.ledger.mutate('schedule', {'name': '每月生活预算', 'amount': '1800.00', 'pool': 'daily',
                    'frequency': 'monthly', 'day': 1, 'time': '09:00'}, 'demo', 'demo-schedule-v1')

    def scheduler(self):
        while not self.stop.is_set():
            try:
                self.ledger.tick()
            except Exception as e:
                logging.error('Scheduler failed (%s); will retry in 30 seconds', type(e).__name__)
            self.stop.wait(30)

    def session(self):
        token, csrf = secrets.token_urlsafe(36), secrets.token_urlsafe(24)
        with self.lock:
            self.sessions = {k:v for k,v in self.sessions.items() if v['expires'] > time.time()}
            self.sessions[digest(token)] = {'actor': 'web', 'admin': True, 'csrf': csrf, 'expires': time.time()+43200}
        return token, csrf


class Handler(BaseHTTPRequestHandler):
    server_version = 'PocketQuota'

    @property
    def app(self):
        return self.server.app

    def log_message(self, *_args):
        # Never print URLs, credentials, request bodies, or personal ledger data.
        pass

    def respond(self, status, value, content_type='application/json; charset=utf-8', extra=None):
        body = value if isinstance(value, bytes) else pack(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        if not extra or 'Content-Security-Policy' not in extra:
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise Problem('需要 application/json', 415)
        if self.headers.get('Transfer-Encoding'):
            raise Problem('不支持分块请求')
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise Problem('Content-Length 无效') from None
        if not 0 < size <= 65536:
            raise Problem('请求为空或超过 64 KiB', 413)
        try:
            result = json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError):
            raise Problem('JSON 无效') from None
        if not isinstance(result, dict):
            raise Problem('请求须为 JSON 对象')
        return result

    def authenticate(self, write=False):
        bearer = self.headers.get('Authorization', '')
        if bearer.startswith('Bearer '):
            value = digest(bearer[7:])
            if hmac.compare_digest(value, self.app.owner_digest):
                return {'actor': 'owner-api', 'admin': True}
            with self.app.ledger.connect() as db:
                token = db.execute('SELECT * FROM tokens WHERE digest=? AND revoked=0', (value,)).fetchone()
            if token:
                scopes = json.loads(token['scopes'])
                if write and 'write' not in scopes:
                    raise Problem('此 Agent 仅有只读权限', 403)
                return {'actor': 'agent:' + token['id'], 'admin': False, 'manage': 'manage' in scopes}
            raise Problem('令牌无效或已撤销', 401)
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
        except Exception:
            raise Problem('请重新登录', 401) from None
        value = cookies.get('pq_session')
        with self.app.lock:
            session = self.app.sessions.get(digest(value.value)) if value else None
        if not session or session['expires'] < time.time():
            raise Problem('请先登录', 401)
        if write:
            if self.headers.get('Origin') not in self.app.origins:
                raise Problem('请求来源不匹配', 403)
            if not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), session['csrf']):
                raise Problem('页面已过期，请刷新', 403)
        return session

    def cookie(self, token, age=43200):
        secure = '; Secure' if self.app.origin and self.app.origin.startswith('https://') else ''
        return f'pq_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}{secure}'

    def do_GET(self):
        self.dispatch(False)

    def do_POST(self):
        self.dispatch(True)

    def dispatch(self, write):
        try:
            if self.headers.get('Host') not in self.app.hosts:
                raise Problem('Host 不在允许列表中，请配置 POCKETQUOTA_ORIGIN', 403)
            origin = self.headers.get('Origin')
            if origin and origin not in self.app.origins:
                raise Problem('不允许跨站请求', 403)
            parsed = urlsplit(self.path)
            path, query = parsed.path, parse_qs(parsed.query)
            if not write and path == '/guide.html':
                raw=(STATIC/'guide.html').read_bytes()
                css=re.search(rb'<style>(.*?)</style>',raw,re.S).group(1)
                style_hash=base64.b64encode(hashlib.sha256(css).digest()).decode()
                return self.respond(200,raw,'text/html; charset=utf-8',{'Content-Security-Policy':
                    "default-src 'none'; style-src 'sha256-"+style_hash+"'; base-uri 'none'; frame-ancestors 'none'"})
            if not write and path in ('/', '/app.js', '/style.css', '/icon.svg'):
                name = 'index.html' if path == '/' else path[1:]
                kind = {'html':'text/html','js':'application/javascript','css':'text/css','svg':'image/svg+xml'}[name.split('.')[-1]]
                return self.respond(200, (STATIC/name).read_bytes(), kind+'; charset=utf-8')
            if not write and path == '/api/health':
                return self.respond(200, {'ok': True, 'version': '0.1.0'})
            if not write and path == '/openapi.json':
                from .api_spec import specification
                return self.respond(200,specification())
            if not write and path == '/api/info':
                return self.respond(200, {'demo': self.app.demo})
            if write and path in ('/api/login', '/api/demo-session'):
                if origin not in self.app.origins:
                    raise Problem('请从本网站登录', 403)
                data = self.body()
                addr = self.client_address[0]
                with self.app.lock:
                    recent = [t for t in self.app.attempts.get(addr, []) if t > time.time()-300]
                    self.app.attempts[addr] = recent
                    if len(recent) >= 10:
                        raise Problem('尝试过多，请五分钟后再试', 429)
                    recent.append(time.time())
                valid = self.app.demo if path.endswith('demo-session') else hmac.compare_digest(digest(text(data.get('token',''),200)), self.app.owner_digest)
                if not valid:
                    raise Problem('登录口令无效', 401)
                token, csrf = self.app.session()
                return self.respond(200, {'csrf': csrf}, extra={'Set-Cookie': self.cookie(token)})
            auth = self.authenticate(write)
            ledger = self.app.ledger
            if not write:
                if path == '/api/session':
                    return self.respond(200, {'csrf':auth.get('csrf'), 'admin':auth['admin'], 'demo':self.app.demo})
                if path == '/api/dashboard':
                    return self.respond(200, ledger.dashboard())
                if path == '/api/entries':
                    return self.respond(200, ledger.entries(query.get('start',[None])[0], query.get('end',[None])[0],
                        int(query.get('limit',['100'])[0]), int(query.get('offset',['0'])[0])))
                if path == '/api/schedules':
                    return self.respond(200, ledger.list_schedules())
                if path == '/api/reviews':
                    return self.respond(200, ledger.list_reviews())
                if path == '/api/notifications':
                    return self.respond(200, ledger.notifications())
                if path == '/api/summary':
                    return self.respond(200, ledger.summary(query.get('period',[''])[0]))
                if path == '/api/export.csv':
                    buf = io.StringIO(newline='')
                    w = csv.writer(buf)
                    w.writerow(['流水ID','日期','类型','指定资金池','金额（元）','分类','备注','来源',
                                '日常实际扣款（元）','灵活实际扣款（元）','保底实际扣款（元）','已撤销','撤销原流水ID'])
                    where,args=[],[]
                    for name,op in [('start','>='),('end','<=')]:
                        value=query.get(name,[''])[0]
                        if value:
                            where.append('e.date'+op+'?');args.append(day(value).isoformat())
                    if len(args)==2 and args[0]>args[1]:
                        raise Problem('起始日期不能晚于截止日期')
                    def amount(cents):
                        return ('-' if cents<0 else '')+f'{abs(cents)//100}.{abs(cents)%100:02d}'
                    def safe(value):
                        v=str(value or '')
                        return "'"+v if v.startswith(('=','+','-','@','\t','\r')) else v
                    names={'daily':'日常池','flex':'灵活池','reserve':'保底池'}
                    labels={'expense':'支出','income':'收入','transfer':'转账','opening':'期初','settlement':'结余划转',
                            'coverage':'承担额修正','adjustment':'余额调整','reversal':'撤销','scheduled_income':'自动入账'}
                    with ledger.connect() as db:
                        q='SELECT e.*,EXISTS(SELECT 1 FROM entries r WHERE r.reverses=e.id) AS reversed FROM entries e'
                        q+=(' WHERE '+' AND '.join(where)) if where else ''
                        for r in db.execute(q+' ORDER BY e.date,e.rowid',args):
                            posts={p['pool']:p['cents'] for p in db.execute('SELECT * FROM postings WHERE entry_id=?',(r['id'],))}
                            w.writerow([r['id'],r['date'],labels.get(r['kind'],r['kind']),names[r['pool']],amount(r['amount']),
                                        safe(r['category']),safe(r['note']),safe(r['actor']),
                                        *[amount(-posts.get(k,0)) if r['kind']=='expense' else '' for k in POOLS],
                                        '是' if r['reversed'] else '否',r['reverses'] or ''])
                    return self.respond(200, ('\ufeff'+buf.getvalue()).encode(), 'text/csv; charset=utf-8',
                                        {'Content-Disposition':'attachment; filename="pocketquota-journal.csv"'})
                if path == '/api/tokens' and auth['admin']:
                    with ledger.connect() as db:
                        values = [dict(r) for r in db.execute('SELECT id,name,scopes,created_at,revoked FROM tokens ORDER BY created_at DESC')]
                    return self.respond(200, values)
                if path == '/api/audit' and auth['admin']:
                    with ledger.connect() as db:
                        return self.respond(200, [dict(r) for r in db.execute('SELECT * FROM audit ORDER BY id DESC LIMIT 100')])
                if path == '/api/rules':
                    with ledger.connect() as db:
                        return self.respond(200, [{**dict(r),'data':json.loads(r['data'])} for r in db.execute('SELECT * FROM rules ORDER BY effective DESC,id DESC')])
                raise Problem('接口不存在或无权限', 404)
            data = self.body()
            if path == '/api/logout':
                cookies=SimpleCookie(); cookies.load(self.headers.get('Cookie',''))
                if cookies.get('pq_session'):
                    with self.app.lock:
                        self.app.sessions.pop(digest(cookies['pq_session'].value), None)
                return self.respond(200, {'ok':True}, extra={'Set-Cookie':self.cookie('',0)})
            if path in ('/api/tokens','/api/tokens/revoke'):
                if not auth['admin']:
                    raise Problem('需要管理员权限',403)
                with ledger.transaction() as db:
                    if path.endswith('revoke'):
                        db.execute('UPDATE tokens SET revoked=1 WHERE id=?',(data.get('id'),))
                        ledger.audit(db, auth['actor'], 'token_revoke', {'id':data.get('id')})
                        return self.respond(200, {'ok':True})
                    name = text(data.get('name','Agent'),60)
                    scopes = data.get('scopes',['read'])
                    if scopes not in (['read'], ['read','write'], ['read','write','manage']):
                        raise Problem('权限须为 read、read/write 或 read/write/manage')
                    if self.app.demo:
                        raise Problem('演示模式不签发持久 Agent 令牌，请部署独立账本',403)
                    token = 'pq_'+secrets.token_urlsafe(32)
                    identifier = secrets.token_hex(16)
                    db.execute('INSERT INTO tokens(id,name,digest,scopes,created_at) VALUES(?,?,?,?,?)',
                               (identifier,name,digest(token),pack(scopes),ledger.stamp()))
                    ledger.audit(db, auth['actor'], 'token_create', {'id':identifier,'name':name,'scopes':scopes})
                return self.respond(201, {'id':identifier,'token':token})
            operations={'/api/setup':'setup','/api/entries':'entry','/api/reverse':'reverse',
                        '/api/settle':'settle','/api/settings':'settings','/api/adjust':'adjust',
                        '/api/schedules':'schedule','/api/reviews':'review','/api/notifications/ack':'ack'}
            if path not in operations:
                raise Problem('接口不存在',404)
            operation = operations[path]
            if not auth['admin'] and operation not in ('entry','reverse','review','ack'):
                if not auth.get('manage') or operation not in ('settings','schedule','adjust','settle'):
                    raise Problem('此 Agent 没有预算管理权限',403)
            result = ledger.mutate(operation,data,auth['actor'],self.headers.get('Idempotency-Key'))
            return self.respond(200,result)
        except Problem as e:
            self.respond(e.status, {'error':str(e)})
        except (ValueError, TypeError):
            self.respond(400, {'error':'请求参数格式不正确'})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            logging.error('Request failed (%s)',type(e).__name__)
            self.respond(500, {'error':'内部错误；本次数据库事务已回滚，请检查服务日志'})


def main():
    parser=argparse.ArgumentParser(description='PocketQuota personal budget server')
    parser.add_argument('--data',default=os.getenv('POCKETQUOTA_DATA','.data'))
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--port',type=int,default=18790)
    parser.add_argument('--demo',action='store_true')
    args=parser.parse_args()
    os.umask(0o077)
    app=App(args.data,args.port,args.demo,os.getenv('POCKETQUOTA_ORIGIN'))
    server=ThreadingHTTPServer((args.host,args.port),Handler)
    server.app=app
    thread=threading.Thread(target=app.scheduler,daemon=True);thread.start()
    print(f'PocketQuota serving on port {args.port}. Owner login token is in {args.data}/admin.token (keep private).',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop.set();server.server_close();thread.join(timeout=5)


if __name__ == '__main__':
    main()
