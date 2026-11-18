import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateVersion, webInventory } from './release.mjs';

test('release rejects mixed component versions and unsafe artifact names', () => {
  assert.equal(candidateVersion({ version: '0.1.0' }, 'version = "0.1.0"', '__version__ = "0.1.0"'), '0.1.0');
  assert.throws(() => candidateVersion({ version: '0.1.0' }, 'version = "0.2.0"', '__version__ = "0.1.0"'), /must match/);
  assert.throws(() => candidateVersion({ version: '0.1.0' }, 'version = "0.1.0"', '__version__ = "0.2.0"'), /must match/);
  assert.throws(() => candidateVersion({ version: '../private' }, '', ''), /valid release version/);
});

test('public component inventory excludes host paths and unselected metadata', () => {
  const report = webInventory({ MIT: [{ name: '@example/library', versions: ['1.0.0'], paths: ['/private/home'], token: 'synthetic-private-field' }] }, '0.1.0');
  assert.equal(report.components[0].purl, 'pkg:npm/%40example/library@1.0.0');
  assert.equal(report.components[0].licenses[0].license.name, 'MIT');
  assert.doesNotMatch(JSON.stringify(report), /private|token|paths/);
});
