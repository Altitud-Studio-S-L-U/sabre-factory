import assert from 'node:assert/strict';
import test from 'node:test';
import { doctor, validateDockerHost } from './platform.mjs';

test('only local Docker endpoints are accepted', () => {
  for (const endpoint of ['unix:///var/run/docker.sock', 'npipe:////./pipe/dockerDesktopLinuxEngine']) assert.doesNotThrow(() => validateDockerHost(endpoint));
  for (const endpoint of ['ssh://host', 'tcp://localhost:2375', 'https://host', '', null]) assert.throws(() => validateDockerHost(endpoint));
});

test('doctor validates engine platform and Compose before reporting readiness', async () => {
  const run = async (_file, args) => ({ stdout: args[0] === 'context' ? '"unix:///var/run/docker.sock"' :
    args[0] === 'version' ? JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: '29.0.0' }) : '2.40.0' });
  assert.equal((await doctor(run)).architecture, 'arm64');
  await assert.rejects(doctor(async (file, args, options) => args[0] === 'version' ?
    { stdout: JSON.stringify({ Os: 'windows', Arch: 'amd64' }) } : run(file, args, options)), /Linux Docker/);
});
test('an explicit Docker context cannot hide a remote engine behind DOCKER_HOST', async () => {
  const run = async () => ({ stdout: JSON.stringify('ssh://remote.example') });
  await assert.rejects(() => doctor(run, { DOCKER_CONTEXT: 'remote', DOCKER_HOST: 'unix:///var/run/docker.sock' }), /local Docker/);
});
