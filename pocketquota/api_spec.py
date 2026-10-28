"""Public, credential-free OpenAPI description of the agent surface."""
from copy import deepcopy
from .mcp import TOOLS


def specification():
    mapping={"budget_status":('/api/dashboard','get'),"budget_transactions":('/api/entries','get'),
             "budget_record":('/api/entries','post'),"budget_reverse":('/api/reverse','post'),
             "budget_summary":('/api/summary','get'),"budget_reconcile":('/api/reviews','post'),
             "budget_notifications":('/api/notifications','get'),"budget_ack_notification":('/api/notifications/ack','post'),
             "budget_configure":('/api/settings','post'),"budget_adjust_pool":('/api/adjust','post'),
             "budget_schedule":('/api/schedules','post'),"budget_schedules":('/api/schedules','get'),
             "budget_settle":('/api/settle','post')}
    paths={}
    for tool in TOOLS:
        path,method=mapping[tool['name']]
        schema=deepcopy(tool['inputSchema'])
        operation={'operationId':tool['name'],'description':tool['description'],'security':[{'bearerAuth':[]}],
                   'responses':{'200':{'description':'Successful result. Monetary output is integer cents.','content':{'application/json':{'schema':{}}}},
                                '400':{'description':'Validation error'},'401':{'description':'Authentication required'},
                                '403':{'description':'Insufficient scope'},'409':{'description':'Idempotency or state conflict'}}}
        if method=='post':
            schema['properties'].pop('request_id',None)
            schema['required']=[r for r in schema['required'] if r!='request_id']
            operation['parameters']=[{'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':8,'maxLength':128}}]
            operation['requestBody']={'required':True,'content':{'application/json':{'schema':schema}}}
        else:
            operation['parameters']=[{'name':k,'in':'query','required':k in schema['required'],'schema':v} for k,v in schema['properties'].items()]
        paths.setdefault(path,{})[method]=operation
    return {'openapi':'3.1.0','info':{'title':'PocketQuota Agent API','version':'0.3.1',
            'description':'Personal budget journal. No bank transactions. Isolated user books; web and agent tokens share the same account. Scoped read/write/manage access.'},
            'servers':[{'url':'https://budget.example.com','description':'Replace with your own instance'}],
            'components':{'securitySchemes':{'bearerAuth':{'type':'http','scheme':'bearer'}}},'paths':paths}
