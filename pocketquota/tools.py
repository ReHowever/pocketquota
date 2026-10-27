"""Function-calling adapter for frameworks without an MCP client."""
import argparse
import json
import sys
from .mcp import TOOLS, call


def definitions(format='openai'):
    if format=='openai':
        return [{'type':'function','function':{'name':t['name'],'description':t['description'],'parameters':t['inputSchema']}} for t in TOOLS]
    if format=='anthropic':
        return [{'name':t['name'],'description':t['description'],'input_schema':t['inputSchema']} for t in TOOLS]
    if format=='gemini':
        return [{'functionDeclarations':[{'name':t['name'],'description':t['description'],'parametersJsonSchema':t['inputSchema']} for t in TOOLS]}]
    raise ValueError('Unknown tool format')


def execute(name, arguments):
    if name not in {t['name'] for t in TOOLS}:
        raise ValueError('Unknown PocketQuota tool')
    if not isinstance(arguments,dict):
        raise ValueError('Tool arguments must be an object')
    return call(name,arguments)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['list','call','openapi'])
    parser.add_argument('name',nargs='?')
    parser.add_argument('--format',choices=['openai','anthropic','gemini'],default='openai')
    args=parser.parse_args()
    if args.action=='list':result=definitions(args.format)
    elif args.action=='openapi':
        from .api_spec import specification
        result=specification()
    else:
        raw=sys.stdin.buffer.read(65537)
        if len(raw)>65536:raise ValueError('Input exceeds 64 KiB')
        result=execute(args.name,json.loads(raw))
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
