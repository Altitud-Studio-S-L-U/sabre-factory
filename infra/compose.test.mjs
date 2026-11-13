import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const compose = readFileSync(new URL('./compose.yml', import.meta.url), 'utf8');

/** The text of one top-level service block. */
function service(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `service ${name} is missing`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('only the Docker proxy mounts the daemon socket, and it has no network', () => {
  const socket = '/var/run/docker.sock:/var/run/docker.sock';
  assert.equal(compose.split(socket).length - 1, 1);
  const proxy = service('docker-proxy');
  assert.ok(proxy.includes(socket));
  assert.match(proxy, /\n {4}network_mode: none\n/);
  assert.doesNotMatch(proxy, /\n {4}networks:/);
  assert.doesNotMatch(proxy, /\n {4}ports:/);
  assert.match(proxy, /\n {4}read_only: true\n/);
  assert.match(proxy, /\n {4}cap_drop: \[ALL\]\n/);
  assert.match(proxy, /\n {4}security_opt: \[no-new-privileges:true\]\n/);
  assert.match(proxy, /\n {4}command: \[python, -m, sabre\.docker_proxy\]\n/);
});

test('the executor reaches Docker through the proxy socket and shares its policy block', () => {
  const executor = service('executor');
  assert.doesNotMatch(executor, /docker\.sock:/);
  assert.match(executor, /\n {6}DOCKER_HOST: unix:\/\/\/run\/docker-proxy\/docker\.sock\n/);
  assert.match(executor, /\n {6}- docker-proxy:\/run\/docker-proxy:ro\n/);
  assert.match(executor, /\n {6}docker-proxy: \{condition: service_healthy\}\n/);
  for (const block of [executor, service('docker-proxy')]) assert.match(block, /\n {6}<<: \*executor-docker\n/);
  // Images, networks and scanner volumes are declared once, so the two services cannot drift.
  for (const key of ['SABRE_HELPER_IMAGE', 'SABRE_PYTHON_IMAGE', 'SABRE_NODE_IMAGE', 'SABRE_BROWSER_IMAGE', 'SABRE_TRIVY_IMAGE',
    'SABRE_SEMGREP_IMAGE', 'SABRE_GITLEAKS_IMAGE', 'SABRE_DEPENDENCY_NETWORK', 'SABRE_SECURITY_UPDATE_NETWORK',
    'SABRE_TRIVY_DB_VOLUME', 'SABRE_SEMGREP_RULES_VOLUME']) {
    assert.equal(compose.split(`\n  ${key}: `).length - 1, 1, key);
    assert.equal(compose.split(`${key}: `).length - 1, 1, key);
  }
});
