import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPlainClaudeVolume } from './claude-bootstrap.mjs';

const name = 'sabre-factory-claude-fixture';
const ordinary = { Name: name, Driver: 'local', Scope: 'local', Options: null,
  Mountpoint: `/var/lib/docker/volumes/${name}/_data`, Labels: { 'sabre.owner': 'factory', 'sabre.kind': 'claude-home' } };

test('Claude accepts an ordinary local volume owned by its declared role', () => {
  assert.doesNotThrow(() => assertPlainClaudeVolume(ordinary, name, 'home'));
});

test('Claude rejects a homonymous labelled host bind before mounting it', () => {
  assert.throws(() => assertPlainClaudeVolume({ ...ordinary, Options: { type: 'none', o: 'bind', device: '/unowned-path' } }, name, 'home'));
});

test('Claude rejects foreign drivers, ownership and paths without touching files', () => {
  for (const changes of [{ Driver: 'plugin' }, { Scope: 'global' }, { Name: 'other-volume' },
    { Labels: { 'sabre.owner': 'other', 'sabre.kind': 'claude-home' } },
    { Mountpoint: '/outside-docker' }, { Mountpoint: `/var/lib/docker/../volumes/${name}/_data` }]) {
    assert.throws(() => assertPlainClaudeVolume({ ...ordinary, ...changes }, name, 'home'));
  }
  assert.throws(() => assertPlainClaudeVolume(ordinary, name, 'bridge'));
});
