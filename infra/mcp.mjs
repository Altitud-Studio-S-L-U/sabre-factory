import { spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { executable, prefix, root, safeEnvironment } from './bootstrap.mjs';

const MAX_INPUT = 64 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const messages = {
  MCP_INPUT_INVALID: 'Uso: node infra/mcp.mjs <tools|tool-name> [arguments.json]. El archivo debe contener un objeto JSON de hasta 64 KiB, sin credenciales.',
  MCP_TOOL_UNAVAILABLE: 'This tool is not in the current SABRE catalog.',
  MCP_TOOL_ERROR: 'SABRE rejected the MCP call. Check its outcome before repeating a mutation.',
  MCP_OUTPUT_LIMIT: 'The response exceeds 1 MiB. Query a specific run before repeating a mutation.',
  MCP_TIMEOUT: 'The MCP call timed out. Check its outcome before repeating a mutation.',
  MCP_UNAVAILABLE: 'The MCP call could not complete. Check that SABRE is running and inspect its state before repeating a mutation.',
};

// The bearer never crosses Docker stdout, arguments, or the host environment.
const program = String.raw`
import asyncio,json,signal,sys
signal.alarm(35)
class Rejected(Exception):
 def __init__(self,code): self.code=code
async def main():
 import httpx2
 from mcp import Client
 from mcp.client.streamable_http import streamable_http_client
 from sabre.security import SecretGuard
 from sabre.settings import Settings
 raw=sys.stdin.buffer.read(65537)
 if len(raw)>65536: raise Rejected('MCP_INPUT_INVALID')
 request=json.loads(raw)
 if not isinstance(request,dict) or not isinstance(request.get('tool'),str) or not isinstance(request.get('arguments'),dict): raise Rejected('MCP_INPUT_INVALID')
 token=Settings().auth_token.get_secret_value()
 guard=SecretGuard([token])
 guard.check(request)
 problem=None
 async with asyncio.timeout(30):
  async with httpx2.AsyncClient(headers={'Authorization':'Bearer '+token},timeout=httpx2.Timeout(20,connect=5),follow_redirects=False,trust_env=False) as http:
   async with Client(streamable_http_client('http://127.0.0.1:8000/mcp/',http_client=http)) as client:
    catalog=await client.list_tools()
    if request['tool']=='tools':
     value={'tools':[tool.model_dump(mode='json',by_alias=True) for tool in catalog.tools]}
    else:
     if request['tool'] not in {tool.name for tool in catalog.tools}:
      problem='MCP_TOOL_UNAVAILABLE'
     else:
      result=await client.call_tool(request['tool'],request['arguments'])
      if getattr(result,'is_error',False) or getattr(result,'isError',False):
       problem='MCP_TOOL_ERROR'
      else:
       value=getattr(result,'structured_content',None)
       if value is None: value=getattr(result,'structuredContent',None)
       if value is None: problem='MCP_TOOL_ERROR'
 # Keep local rejections outside SDK task groups, which otherwise wrap their type.
 if problem: raise Rejected(problem)
 guard.check(value)
 output=json.dumps({'ok':True,'value':value},ensure_ascii=False).encode()
 if len(output)+1>1048576: raise Rejected('MCP_OUTPUT_LIMIT')
 sys.stdout.buffer.write(output+b'\n')
try: asyncio.run(main())
except Rejected as error: print(json.dumps({'ok':False,'code':error.code}))
except TimeoutError: print(json.dumps({'ok':False,'code':'MCP_TIMEOUT'}))
except Exception: print(json.dumps({'ok':False,'code':'MCP_UNAVAILABLE'}))
`;

function failure(code) {
  return Object.assign(new Error(messages[code]), { code });
}

export function argumentsFrom(argv) {
  const [tool = 'tools', path, ...extra] = argv;
  if (extra.length || !/^(tools|sabre_[a-z_]{1,80})$/.test(tool) || tool === 'tools' && path) throw failure('MCP_INPUT_INVALID');
  let args = {};
  if (path) {
    let descriptor;
    try {
      descriptor = openSync(path, 'r');
      if (!fstatSync(descriptor).isFile()) throw failure('MCP_INPUT_INVALID');
      const bytes = Buffer.alloc(MAX_INPUT + 1);
      let length = 0;
      while (length <= MAX_INPUT) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_INPUT) throw failure('MCP_INPUT_INVALID');
      args = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    } catch {
      throw failure('MCP_INPUT_INVALID');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  if (!args || Array.isArray(args) || typeof args !== 'object') throw failure('MCP_INPUT_INVALID');
  const payload = Buffer.from(JSON.stringify({ tool, arguments: args }));
  if (payload.length > MAX_INPUT) throw failure('MCP_INPUT_INVALID');
  return payload;
}

export async function invokeMcp(payload, { spawnProcess = spawn, timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(executable, [...prefix, 'exec', '-i', 'sabre-factory-api-1', 'python', '-I', '-c', program],
        { cwd: root, windowsHide: true, env: safeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { reject(failure('MCP_UNAVAILABLE')); return; }
    let settled = false;
    const chunks = [];
    let size = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish(failure('MCP_TIMEOUT')), timeoutMs);
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_OUTPUT) finish(failure('MCP_OUTPUT_LIMIT'));
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => finish(failure('MCP_UNAVAILABLE')));
    child.once('error', () => finish(failure('MCP_UNAVAILABLE')));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) { finish(failure('MCP_UNAVAILABLE')); return; }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result?.ok !== true || !Object.hasOwn(result, 'value')) {
          finish(failure(Object.hasOwn(messages, result?.code) ? result.code : 'MCP_UNAVAILABLE'));
        } else finish(null, result.value);
      } catch { finish(failure('MCP_UNAVAILABLE')); }
    });
    child.stdin.end(payload);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const value = await invokeMcp(argumentsFrom(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(value) + '\n');
  } catch (error) {
    const code = Object.hasOwn(messages, error.code) ? error.code : 'MCP_UNAVAILABLE';
    process.stderr.write(JSON.stringify({ error: { code, message: messages[code] } }) + '\n');
    process.exitCode = 1;
  }
}
