import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { docker, root, rawSecretNames, volumes, controlEnvironment, privateJson } from './bootstrap.mjs';
import { codexVolumes, verifyCodexSeccomp } from './codex-bootstrap.mjs';
import { claudeVolumes } from './claude-bootstrap.mjs';
import { backupImageReference } from './image-identity.mjs';

async function verifyImage(container, reference) {
  const [image] = privateJson((await docker(['image', 'inspect', reference])).toString());
  const [selected] = container.ImageManifestDescriptor?.platform
    ? privateJson((await docker(['image', 'inspect', '--platform', `${container.ImageManifestDescriptor.platform.os}/${container.ImageManifestDescriptor.platform.architecture}`, reference])).toString())
    : [image];
  backupImageReference(container, image, selected);
}

const publicConfig = Object.fromEntries(readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const usesCodex = publicConfig.SABRE_MODEL_PROVIDER === 'codex_cli'
  || Object.values(privateJson(publicConfig.SABRE_ROLE_MODELS || '{}')).some((role) => role.model_provider === 'codex_cli');
const names = ['api', 'worker', 'control', 'executor', 'postgres', 'dependencies-proxy', 'security-proxy']
  .map((service) => `sabre-factory-${service}-1`);
const configured = (await docker(['ps', '-a', '--filter', 'label=com.docker.compose.project=sabre-factory', '--format', '{{.Names}}'])).toString().trim().split('\n');
if (configured.includes('sabre-factory-jaeger-1')) names.push('sabre-factory-jaeger-1');
if (usesCodex) names.push('sabre-factory-codex-runner-1');
const claudeRunning = (await docker(['ps', '--filter', 'label=com.docker.compose.project=sabre-factory',
  '--filter', 'label=com.docker.compose.service=claude-runner', '--format', '{{.Names}}'])).toString().trim() === 'sabre-factory-claude-runner-1';
if (claudeRunning) names.push('sabre-factory-claude-runner-1');
const rows = JSON.parse((await docker(['inspect', ...names])).toString());
for (const row of rows) {
  if (row.Config.Labels?.['com.docker.compose.project'] !== 'sabre-factory' || !row.State.Running) throw new Error('A required SABRE service is absent or stopped');
  if (row.Config.Env.some((line) => rawSecretNames.has(line.split('=')[0].toUpperCase()))) throw new Error('A raw credential variable remains in a service configuration');
  if (['/sabre-factory-api-1', '/sabre-factory-worker-1', '/sabre-factory-control-1', '/sabre-factory-executor-1'].includes(row.Name)) await verifyImage(row, 'sabre-factory-api:local');
}
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  if (rawSecretNames.has(line.split('=')[0])) throw new Error('A raw credential field remains in local public configuration');
}
const sum = createHash('sha256');
const source = resolve(root, 'backend/src/sabre');
for (const name of readdirSync(source, { recursive: true }).filter((name) => name.endsWith('.py')).sort()) {
  sum.update(name.replaceAll('\\', '/') + '\0'); sum.update(readFileSync(resolve(source, name)));
}
const hostDigest = sum.digest('hex');
const canary = 'synthetic-access-log-canary-20261105';
const program = String.raw`
import asyncio, hashlib, json, pathlib, urllib.request, urllib.error
import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from sabre.settings import Settings
cfg=Settings()
headers={'Authorization':'Bearer '+cfg.auth_token.get_secret_value()}
def get(path,authorized=True):
 request=urllib.request.Request('http://127.0.0.1:8000'+path,headers=headers if authorized else {})
 try:
  with urllib.request.urlopen(request,timeout=10) as response: return response.status
 except urllib.error.HTTPError as error: return error.code
async def main():
 if get('/health')!=200 or get('/api/v1/status')!=200 or get('/api/v1/status',False)!=401: raise RuntimeError('API authentication check failed')
 get('/api/v1/memory/search?project_id=synthetic-log-check&query=synthetic-access-log-canary-20261105&commit='+'a'*40)
 async with httpx2.AsyncClient(headers=headers,timeout=30) as http:
  async with Client(streamable_http_client('http://127.0.0.1:8000/mcp/',http_client=http)) as client:
   tools=await client.list_tools()
   result=await client.call_tool('sabre_list_work',{})
   if getattr(result,'is_error',False) or getattr(result,'isError',False): raise RuntimeError('MCP read check failed')
 digest=hashlib.sha256()
 base=pathlib.Path('/app/src/sabre')
 for path in sorted(base.rglob('*.py')):
  digest.update(path.relative_to(base).as_posix().encode()+b'\0'); digest.update(path.read_bytes())
 print(json.dumps({'api_health':200,'authenticated_status':200,'unauthorized_status':401,'mcp_tools':len(tools.tools),'source_digest':digest.hexdigest()}))
try: asyncio.run(main())
except Exception as error: print(json.dumps({'check_error':type(error).__name__}))
`;
const value = JSON.parse((await docker(['run', '--rm', '--network', 'container:sabre-factory-api-1', '--read-only', '--memory', '256m',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', `${volumes.control}:/run/secrets/sabre:ro`, ...controlEnvironment,
  'sabre-factory-api:local', 'python', '-I', '-c', program])).toString());
if (value.check_error) throw new Error(`Runtime verification failed (${value.check_error}); no private error content was recorded`);
if (value.source_digest !== hostDigest) throw new Error('The running application image differs from the current backend source');
const logs = (await docker(['logs', 'sabre-factory-api-1'], undefined, undefined, true)).toString();
if (logs.includes(canary)) throw new Error('The API recorded the synthetic query canary in application logs');
let codex = {};
if (usesCodex) {
  const runner = rows.find((row) => row.Name === '/sabre-factory-codex-runner-1');
  await verifyImage(runner, 'sabre-factory-codex-runner:local');
  const networks = Object.keys(runner.NetworkSettings.Networks).sort();
  const mounts = runner.Mounts.filter((mount) => mount.Type !== 'tmpfs');
  if (runner.Config.User !== '10001:10001'
      || !runner.HostConfig.ReadonlyRootfs || runner.HostConfig.Privileged
      || !runner.HostConfig.CapDrop?.includes('ALL')
      || (runner.HostConfig.CapAdd?.length ?? 0) !== 0
      || !runner.HostConfig.SecurityOpt?.includes('no-new-privileges:true')
      || Object.keys(runner.HostConfig.PortBindings || {}).length
      || JSON.stringify(networks) !== JSON.stringify(['sabre-factory_codex_control', 'sabre-factory_codex_outbound'])
      || mounts.length !== 2
      || !mounts.some((mount) => mount.Type === 'volume' && mount.Name === codexVolumes.home && mount.Destination === '/var/lib/sabre-codex' && mount.RW)
      || !mounts.some((mount) => mount.Type === 'volume' && mount.Name === codexVolumes.bridge && mount.Destination === '/run/secrets/codex-bridge' && !mount.RW)) {
    throw new Error('The Codex runner differs from its isolated runtime profile');
  }
  await verifyCodexSeccomp(runner.HostConfig.SecurityOpt);
  const check = String.raw`
import json,urllib.request,urllib.error
from sabre.codex_model import read_bridge_token
headers={'Authorization':'Bearer '+read_bridge_token()}
def get(path,authorized=True):
 request=urllib.request.Request('http://127.0.0.1:8091'+path,headers=headers if authorized else {})
 try:
  with urllib.request.urlopen(request,timeout=20) as response: return response.status,json.load(response)
 except urllib.error.HTTPError as error: return error.code,{}
try:
 health,_=get('/health',False)
 unauthorized,_=get('/status',False)
 status,result=get('/status')
 if health!=200 or unauthorized!=401 or status!=200: raise RuntimeError('Codex check failed')
 print(json.dumps({'codex_health':health,'codex_unauthorized_status':unauthorized,'codex_authenticated':result['authenticated']}))
except Exception as error: print(json.dumps({'check_error':type(error).__name__}))
`;
  codex = JSON.parse((await docker(['exec', 'sabre-factory-codex-runner-1', 'python', '-I', '-c', check])).toString());
  if (codex.check_error) throw new Error(`Codex runtime verification failed (${codex.check_error}); no private error content was recorded`);
  codex.codex_seccomp_verified = true;
}
let claude = { claude_available: false };
if (claudeRunning) {
  const runner = rows.find((row) => row.Name === '/sabre-factory-claude-runner-1');
  await verifyImage(runner, 'sabre-factory-claude-runner:local');
  const mounts = runner.Mounts.filter((mount) => mount.Type !== 'tmpfs');
  if (runner.Config.User !== '10001:10001' || !runner.HostConfig.ReadonlyRootfs || runner.HostConfig.Privileged
      || !runner.HostConfig.CapDrop?.includes('ALL') || (runner.HostConfig.CapAdd?.length ?? 0) !== 0
      || !runner.HostConfig.SecurityOpt?.includes('no-new-privileges:true') || runner.HostConfig.SecurityOpt.some((option) => option.startsWith('seccomp='))
      || Object.keys(runner.HostConfig.PortBindings || {}).length || mounts.length !== 2
      || !mounts.some((mount) => mount.Name === claudeVolumes.home && mount.Destination === '/var/lib/sabre-claude' && mount.RW)
      || !mounts.some((mount) => mount.Name === claudeVolumes.bridge && mount.Destination === '/run/secrets/claude-bridge' && !mount.RW)
      || Object.keys(runner.NetworkSettings.Networks).sort().join('|') !== ['sabre-factory_claude_control', 'sabre-factory_claude_outbound'].join('|')) {
    throw new Error('The Claude runner differs from its isolated runtime profile');
  }
  const check = String.raw`
import json,urllib.request,urllib.error
from sabre.claude_model import read_bridge_token
headers={'Authorization':'Bearer '+read_bridge_token()}
def get(path,authorized=True):
 request=urllib.request.Request('http://127.0.0.1:8092'+path,headers=headers if authorized else {})
 try:
  with urllib.request.urlopen(request,timeout=30) as response: return response.status,json.load(response)
 except urllib.error.HTTPError as error: return error.code,{}
try:
 health,_=get('/health',False)
 unauthorized,_=get('/status',False)
 status,result=get('/status')
 if health!=200 or unauthorized!=401 or status!=200 or type(result.get('authenticated')) is not bool: raise RuntimeError('Claude status check failed')
 print(json.dumps({'claude_available':True,'claude_health':health,'claude_unauthorized_status':unauthorized,'claude_authenticated':result['authenticated']}))
except Exception as error: print(json.dumps({'check_error':type(error).__name__}))
`;
  claude = JSON.parse((await docker(['exec', 'sabre-factory-claude-runner-1', 'python', '-I', '-c', check])).toString());
  if (claude.check_error) throw new Error(`Claude runtime verification failed (${claude.check_error}); no private error content was recorded`);
}
console.log(JSON.stringify({ ...value, ...codex, ...claude, credential_env_fields: 0, public_env_secret_fields: 0, query_canary_logged: false }));
