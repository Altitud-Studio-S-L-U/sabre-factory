import assert from 'node:assert/strict';
import test from 'node:test';
import { backendInventory, candidateVersion, webInventory } from './release.mjs';

test('release rejects mixed component versions and unsafe artifact names', () => {
  assert.equal(candidateVersion({ version: '0.1.0' }, 'version = "0.1.0"', '__version__ = "0.1.0"'), '0.1.0');
  assert.throws(() => candidateVersion({ version: '0.1.0' }, 'version = "0.2.0"', '__version__ = "0.1.0"'), /must match/);
  assert.throws(() => candidateVersion({ version: '0.1.0' }, 'version = "0.1.0"', '__version__ = "0.2.0"'), /must match/);
  assert.throws(() => candidateVersion({ version: '../private' }, '', ''), /valid release version/);
});

test('Python inventory attributes licenses only to matching installed versions', () => {
  const report = backendInventory({ components: [
    { name: 'some_package', version: '1.0' }, { name: 'other', version: '2.0' }, { name: 'platform-only', version: '3.0' },
  ] }, [
    { name: 'Some-Package', version: '1.0', expression: 'MIT', paths: ['/private/home'] },
    { name: 'other', version: '1.0', expression: 'Apache-2.0' },
  ]);
  assert.deepEqual(report.components[0].licenses, [{ expression: 'MIT' }]);
  assert.equal(report.components[1].licenses, undefined);
  assert.equal(report.components[2].properties[0].name, 'sabre:license-review');
  assert.doesNotMatch(JSON.stringify(report), /private|paths|Apache-2.0/);
});

test('public component inventory excludes host paths and unselected metadata', () => {
  const report = webInventory({ MIT: [{ name: '@example/library', versions: ['1.0.0'], paths: ['/private/home'], token: 'synthetic-private-field' }] }, '0.1.0');
  assert.equal(report.components[0].purl, 'pkg:npm/%40example/library@1.0.0');
  assert.equal(report.components[0].licenses[0].license.name, 'MIT');
  assert.doesNotMatch(JSON.stringify(report), /private|token|paths/);
});
