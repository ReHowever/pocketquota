"""Owner-scoped adapter for the existing Harness legacy executor."""
import asyncio
import os
import hashlib
import json
from decimal import Decimal
from pathlib import Path
from pocketquota.mcp import TOOLS, call

# Use a dedicated token for exactly one user; configure the dispatcher to accept only that owner.
# Secrets stay in the host process environment, outside the source tree.
MAPPING={
 'budget_status':('/api/dashboard',False),'budget_transactions':('/api/entries',False),
 'budget_record':('/api/entries',True),'budget_reverse':('/api/reverse',True),
 'budget_summary':('/api/summary',False),'budget_reconcile':('/api/reviews',True),
 'budget_notifications':('/api/notifications',False),'budget_ack_notification':('/api/notifications/ack',True),
 'budget_configure':('/api/settings',True),'budget_adjust_pool':('/api/adjust',True),
 'budget_schedule':('/api/schedules',True),'budget_schedules':('/api/schedules',False),'budget_settle':('/api/settle',True)}

def declarations():
    return [dict(name=t['name'],description=t['description'],parameters=t['inputSchema'],plugin='pocketquota') for t in TOOLS if t['name'] not in {'budget_configure','budget_adjust_pool','budget_schedule','budget_settle'}]

async def request(path,payload=None,key=None):
    from urllib.parse import parse_qsl, urlsplit
    parts = urlsplit(path)
    mapping = next((name for name, (route, write) in MAPPING.items()
                    if route == parts.path and write == (payload is not None)), None)
    if mapping is None:
        raise ValueError('Unsupported PocketQuota route')
    args = dict(payload) if payload is not None else dict(parse_qsl(parts.query))
    if key:
        args['request_id'] = key
    # Reuse the standard bridge: validated TLS, no redirects/proxies, remote HTTPS only.
    return await asyncio.to_thread(call, mapping, args)

async def records(args):
    from urllib.parse import urlencode
    today=(await request('/api/dashboard'))['today']
    scope=args.get('scope','today');q={}
    if scope=='today':q={'start':today,'end':today}
    elif scope=='month':q={'start':today[:7]+'-01','end':today}
    elif scope=='range':q={'start':args['start_date'],'end':args['end_date']}
    elif scope!='all':raise ValueError('Unknown bookkeeping scope')
    result=[];offset=0
    while True:
        page=await request('/api/entries?'+urlencode({**q,'limit':100,'offset':offset}))
        result.extend(x for x in page['items'] if x['kind'] in ('expense','legacy_expense') and not x['reversed'])
        offset+=len(page['items'])
        if offset>=page['total'] or not page['items']:break
    result.sort(key=lambda x:(x['date'],str(x['created_at']),x['id']))
    return [dict(record_id=x['id'],item=x['category'] or x['note'],amount=format(Decimal(x['amount'])/100,'.2f'),
                 note=x['note'],date=x['date'],timestamp=x['created_at'],pool=x['pool'],archived=x['kind']=='legacy_expense') for x in result]

async def invoke(d,dry_run=False):
    name=d['name'];args=dict(d.get('args',{}))
    if name in MAPPING:
        from urllib.parse import urlencode
        path,write=MAPPING[name];key=args.pop('request_id',None)
        if write and not key:raise ValueError('Stable request_id required')
        if write and dry_run:return {'dry_run':True,'tool':name}
        return await request(path if write or not args else path+'?'+urlencode(args),args if write else None,key)
    if name=='bookkeeper_list_expenses':return json.dumps({'records':await records(args),'source':'PocketQuota'},ensure_ascii=False)
    source=str(d.get('source_id') or '')
    if not source:raise ValueError('Stable source_id required; no transaction was written')
    key='harness-'+hashlib.sha256(json.dumps([source,name],ensure_ascii=False).encode()).hexdigest()
    if dry_run:return {'dry_run':True,'tool':name}
    if name=='bookkeeper_add_expense':
        config = os.environ.get('POCKETQUOTA_LEGACY_CONFIG')
        original = json.loads(Path(config).read_text()) if config else {}
        if not original.get('auto_extract_enabled',True):return 'Bookkeeping skipped: auto_extract_enabled is off.'
        item=str(args.get('item',''));note=str(args.get('note',''))
        target=args.get('pool','daily')
        if target not in ('daily','flex','reserve'):raise ValueError('Unknown pool')
        result=await request('/api/entries',{'kind':'expense','amount':str(args['amount']),
            'pool':target,'category':item[:40],'note':(item+(' · '+note if note else ''))[:240]},key)
        return json.dumps({'saved':True,**result,'source':'PocketQuota'},ensure_ascii=False)
    if name=='bookkeeper_delete_expense':
        identifier=args.get('record_id')
        if not identifier:
            rows=await records(args);i=int(args.get('index',0))-1
            if not 0<=i<len(rows):raise ValueError('Invalid record index')
            identifier=rows[i]['record_id']
        return await request('/api/reverse',{'id':identifier,'reason':'用户通过 Harness/Luma 撤销'},key)
    raise ValueError('Unknown bookkeeping tool')

async def command(d,dry_run=False):
    parts=d['text'].lstrip('/').split()
    if not parts or parts[0] not in ('book','bk'):return None
    action=parts[1] if len(parts)>1 else 'status'
    if action in ('today','month','all','range'):
        args={'scope':action}
        if action=='range':args.update(start_date=parts[2],end_date=parts[3])
        result=await records(args)
    elif action in ('status','summary'):result=await request('/api/dashboard')
    elif action=='del':
        args={'scope':'month' if len(parts)>3 and parts[2]=='month' else 'today','index':int(parts[-1])}
        rows=await records(args);i=args['index']-1
        if not 0<=i<len(rows):raise ValueError('Invalid record index')
        eid=rows[i]['record_id']
        result={'dry_run':True} if dry_run else await request('/api/reverse',{'id':eid,'reason':'用户通过 book del 撤销'},'book-delete-'+eid)
    else:return None
    return {'handled':True,'result':[{'text':json.dumps(result,ensure_ascii=False)}]}
