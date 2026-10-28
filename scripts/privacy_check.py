"""Check tracked files and reachable Git blobs; never print matching secret values.

This is a release guard, not a replacement for Gitleaks or human review.
Optionally set PRIVATE_MARKERS_FILE to a private newline-delimited deny list
OUTSIDE the repository. The list and its contents are never printed.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(['git',*args],cwd=ROOT)


PATTERNS={
    'private-key':re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'github-token':re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,})'),
    'api-secret':re.compile(r'\bsk-[A-Za-z0-9_-]{24,}'),
    'jwt':re.compile(r'\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{15,}'),
    'personal-path':re.compile(r'/(?:Users|home)/[a-zA-Z][^\s/"\']+/'),
    'windows-personal-path':re.compile(r'[A-Za-z]:[\\/]Users[\\/][^\s\\/"\']+[\\/]',re.I),
    'private-mail':re.compile(r'\b[A-Za-z0-9._%+-]+@(?:qq|163|126|gmail|outlook|hotmail)\.com\b',re.I),
    'phone':re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)'),
}
DENIED_SUFFIX=('.sqlite','.sqlite3','.db','.token','.pem','.key','.p12','.pfx')


def main():
    paths=git('ls-files','-z').decode().split('\0')
    paths=[p for p in paths if p]
    markers=[]
    if os.getenv('PRIVATE_MARKERS_FILE'):
        markers=[s.strip() for s in Path(os.environ['PRIVATE_MARKERS_FILE']).read_text().splitlines() if s.strip()]
    findings=[];seen=set();count=0

    def scan(label,raw):
        nonlocal count
        if raw in seen:return
        seen.add(raw);count+=1
        try:value=raw.decode('utf-8')
        except UnicodeDecodeError:
            if not raw.startswith((b'\x89PNG\r\n\x1a\n',b'\xff\xd8\xff')):
                findings.append((label,'unreviewed-binary'))
            return
        for name,pattern in PATTERNS.items():
            if pattern.search(value):findings.append((label,name))
        for marker in markers:
            if marker.casefold() in value.casefold():
                findings.append((label,'private-deny-list'));break

    for name in paths:
        p=Path(name)
        if any(x in p.parts for x in ('.data','.demo-data','.test-data','private','.venv')) or name.endswith(DENIED_SUFFIX) or p.name.startswith('.env'):
            findings.append((name,'private-runtime-file'))
        local=ROOT/name
        if local.is_file():scan(name,local.read_bytes())
    try:
        objects=git('rev-list','--objects','--all').decode().splitlines()
    except subprocess.CalledProcessError:objects=[]
    for line in objects:
        object_id,_,label=line.partition(' ')
        if git('cat-file','-t',object_id).strip()==b'blob':
            scan('history:'+label,git('cat-file','blob',object_id))
    if findings:
        for label,kind in sorted(set(findings)):print(f'FAIL {kind}: {label}')
        print('Private values redacted. Resolve findings BEFORE upload.')
        return 1
    print(f'PASS: {len(paths)} tracked paths; {count} unique text/binary objects checked. No matches.')
    return 0


if __name__=='__main__':sys.exit(main())
