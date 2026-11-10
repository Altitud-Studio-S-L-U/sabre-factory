import assert from 'node:assert/strict';
import test from 'node:test';
import { backupImageReference } from './image-identity.mjs';

const digest = (value) => `sha256:${value.repeat(64)}`;
test('classic image stores retain their directly addressable image identity', () => {
  assert.equal(backupImageReference({ Image: digest('a') }, { Id: digest('a') }), digest('a'));
});
test('containerd backups use the index only after the running manifest matches', () => {
  const container = { Image: digest('a'), ImageManifestDescriptor: { digest: digest('b') } };
  assert.equal(backupImageReference(container, { Id: digest('c') }, { Descriptor: { digest: digest('b') } }), digest('c'));
  assert.throws(() => backupImageReference(container, { Id: digest('c') }, { Descriptor: { digest: digest('d') } }), /does not match/);
  assert.throws(() => backupImageReference(container, { Id: 'mutable:tag' }, { Descriptor: { digest: digest('b') } }), /does not match/);
});
