import assert from 'node:assert/strict';
import test from 'node:test';
import { webInventory } from './release.mjs';

test('public component inventory excludes host paths and unselected metadata', () => {
  const report = webInventory({ MIT: [{ name: '@example/library', versions: ['1.0.0'], paths: ['/private/home'], token: 'synthetic-private-field' }] }, '0.1.0');
  assert.equal(report.components[0].purl, 'pkg:npm/%40example/library@1.0.0');
  assert.equal(report.components[0].licenses[0].license.name, 'MIT');
  assert.doesNotMatch(JSON.stringify(report), /private|token|paths/);
});
