import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const executable = 'docker';
export const prefix = [];

export function validateDockerHost(endpoint) {
  if (typeof endpoint !== 'string' || !/^(unix:\/\/\/|npipe:\/\/\/)/.test(endpoint)) {
    throw new Error('SABRE requires a local Docker Engine or Docker Desktop context. Remote Docker hosts are not supported.');
  }
}

export async function doctor(run = execute, environment = process.env) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error('Node.js 24 or later is required.');
  const options = { windowsHide: true, timeout: 15000, maxBuffer: 65536 };
  const context = await run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], options);
  validateDockerHost(environment.DOCKER_CONTEXT ? JSON.parse(context.stdout.trim()) : environment.DOCKER_HOST || JSON.parse(context.stdout.trim()));
  const version = await run('docker', ['version', '--format', '{{json .Server}}'], options);
  const server = JSON.parse(version.stdout);
  if (server.Os !== 'linux' || !['amd64', 'arm64'].includes(server.Arch)) {
    throw new Error('A Linux Docker engine on amd64 or arm64 is required. Select Linux containers in Docker Desktop.');
  }
  const compose = await run('docker', ['compose', 'version', '--short'], options);
  if (!/^v?[2-9]\./.test(compose.stdout.trim())) throw new Error('Docker Compose v2 or later is required.');
  return { node: process.versions.node, host: process.platform, architecture: server.Arch,
    docker: server.Version, compose: compose.stdout.trim() };
}
