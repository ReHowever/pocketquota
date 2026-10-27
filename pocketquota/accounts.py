"""Isolated account identities; agents authenticate as members of an owner's account."""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import string
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .engine import Connection, Problem, pack, text


def strong_password():
    alphabet=string.ascii_letters+string.digits+'!@#%+=_-'
    while True:
        value=''.join(secrets.choice(alphabet) for _ in range(26))
        if all(any(c in group for c in value) for group in (string.ascii_uppercase,string.ascii_lowercase,string.digits,'!@#%+=_-')):
            return value


def password_hash(password,salt):
    return hashlib.scrypt(password.encode('utf-8'),salt=bytes.fromhex(salt),n=32768,r=8,p=3,dklen=32,maxmem=64*1024*1024).hex()


def username(value):
    if not isinstance(value,str) or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}',value):
        raise Problem('账号须为 3–40 位字母、数字、点、横线或下划线')
    return value.lower()


class Accounts:
    def __init__(self,root):
        self.root=Path(root)
        self.path=self.root/'accounts.sqlite3'
        with self.connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,
                salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS agent_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
                name TEXT NOT NULL,digest TEXT UNIQUE NOT NULL,scopes TEXT NOT NULL,
                created_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
            ''')
            exists=db.execute("SELECT 1 FROM users WHERE id='owner'").fetchone()
        if not exists:
            credentials=self.create('admin',identifier='owner')
            # A local, one-time bootstrap handoff. Removed after first successful login.
            bootstrap=self.root/'initial-admin.json'
            fd=os.open(bootstrap,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as f:json.dump(credentials,f,ensure_ascii=False)

    def connect(self):
        db=sqlite3.connect(self.path,timeout=20,factory=Connection)
        db.row_factory=sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def create(self,name,identifier=None):
        name=username(name)
        secret=strong_password();salt=secrets.token_hex(16);hashed=password_hash(secret,salt)
        identifier=identifier or uuid.uuid4().hex
        try:
            with self.connect() as db:
                db.execute('INSERT INTO users(id,username,salt,password_hash,created_at) VALUES(?,?,?,?,?)',
                           (identifier,name,salt,hashed,datetime.now(timezone.utc).isoformat()))
        except sqlite3.IntegrityError:
            raise Problem('该账号已存在',409) from None
        return {'id':identifier,'username':name,'password':secret}

    def verify(self,name,password):
        if not isinstance(name,str) or not isinstance(password,str) or not 1<=len(password)<=256:
            return None
        with self.connect() as db:
            row=db.execute('SELECT * FROM users WHERE username=? AND active=1',(name.lower(),)).fetchone()
        # Use the same expensive operation for unknown usernames to reduce enumeration timing.
        salt=row['salt'] if row else '0'*32
        hashed=password_hash(password,salt)
        if not row or not hmac.compare_digest(hashed,row['password_hash']):return None
        if row['id']=='owner':
            (self.root/'initial-admin.json').unlink(missing_ok=True)
        return {k:row[k] for k in ('id','username','active','version')}

    def get(self,identifier):
        if not isinstance(identifier,str):return None
        with self.connect() as db:
            row=db.execute('SELECT id,username,active,version FROM users WHERE id=?',(identifier,)).fetchone()
        return dict(row) if row else None

    def list(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute('SELECT id,username,active,created_at FROM users ORDER BY created_at')]

    def set_active(self,identifier,active):
        if identifier=='owner':raise Problem('不能禁用默认管理员')
        if type(active) is not bool:raise Problem('状态必须为布尔值')
        with self.connect() as db:
            cur=db.execute('UPDATE users SET active=?,version=version+1 WHERE id=?',(int(active),identifier))
            if not cur.rowcount:raise Problem('账号不存在',404)
            if not active:db.execute('UPDATE agent_tokens SET revoked=1 WHERE user_id=?',(identifier,))
        return {'ok':True}

    def reset(self,identifier,password=None):
        if not self.get(identifier):raise Problem('账号不存在',404)
        secret=password or strong_password()
        if not isinstance(secret,str) or not 12<=len(secret)<=256:raise Problem('密码须为 12–256 个字符')
        salt=secrets.token_hex(16);hashed=password_hash(secret,salt)
        with self.connect() as db:
            db.execute('UPDATE users SET salt=?,password_hash=?,version=version+1 WHERE id=?',(salt,hashed,identifier))
            db.execute('UPDATE agent_tokens SET revoked=1 WHERE user_id=?',(identifier,))
        if identifier=='owner':
            (self.root/'initial-admin.json').unlink(missing_ok=True)
            key=self.root/'admin.token'
            temp=self.root/'.admin.token.new'
            fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
            with os.fdopen(fd,'w') as f:f.write(secrets.token_urlsafe(36)+'\n')
            os.replace(temp,key)
        return secret

    def create_token(self,user_id,name,scopes):
        name=text(name,60)
        if scopes not in (['read'],['read','write'],['read','write','manage']):raise Problem('权限组合无效')
        token='pq_'+secrets.token_urlsafe(32);identifier=secrets.token_hex(16)
        with self.connect() as db:
            db.execute('INSERT INTO agent_tokens(id,user_id,name,digest,scopes,created_at) VALUES(?,?,?,?,?,?)',
                       (identifier,user_id,name,hashlib.sha256(token.encode()).hexdigest(),pack(scopes),datetime.now(timezone.utc).isoformat()))
        return {'id':identifier,'token':token}

    def tokens(self,user_id):
        with self.connect() as db:
            return [dict(r) for r in db.execute('SELECT id,name,scopes,created_at,revoked FROM agent_tokens WHERE user_id=? ORDER BY created_at DESC',(user_id,))]

    def revoke(self,user_id,identifier):
        with self.connect() as db:
            cur=db.execute('UPDATE agent_tokens SET revoked=1 WHERE user_id=? AND id=?',(user_id,identifier))
            if not cur.rowcount:raise Problem('令牌不存在',404)

    def authenticate_token(self,hashed):
        with self.connect() as db:
            row=db.execute('''SELECT t.id,t.user_id,t.scopes,u.username FROM agent_tokens t JOIN users u ON u.id=t.user_id
                              WHERE t.digest=? AND t.revoked=0 AND u.active=1''',(hashed,)).fetchone()
        return dict(row) if row else None


def main():
    import argparse
    parser=argparse.ArgumentParser(description='Local account recovery (outputs a new random password once)')
    parser.add_argument('action',choices=['reset-admin'])
    parser.add_argument('--data',default='.data')
    args=parser.parse_args()
    root=Path(args.data)
    if not (root/'accounts.sqlite3').is_file():
        parser.error('No existing account database; start the server first')
    account=Accounts(root)
    print(json.dumps({'username':'admin','password':account.reset('owner')},ensure_ascii=False))


if __name__=='__main__':main()
