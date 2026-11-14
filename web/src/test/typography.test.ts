import { expect, it } from 'vitest';

const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * Sizes written out in a class or an SVG attribute, in CSS pixels. The scale's own classes
 * (text-xs and up) start at 12 px, so only literal sizes can go below the floor.
 */
function literalSizes(source: string): number[] {
  const sizes: number[] = [];
  for (const match of source.matchAll(/text-\[([0-9.]+)(px|rem)\]/g))
    sizes.push(Number(match[1]) * (match[2] === 'rem' ? 16 : 1));
  // The values of the expression, not the numbers it compares with.
  for (const attribute of source.matchAll(/fontSize=\{([^}]*)\}/g))
    for (const value of `{${attribute[1]}}`.matchAll(/(?<=[{?:]\s*)[0-9.]+(?=\s*[}:])/g))
      sizes.push(Number(value[0]));
  return sizes;
}

it('reads literal sizes from classes and from SVG attributes', () => {
  expect(literalSizes('className="text-[0.6875rem] text-[13px] text-xs"')).toEqual([11, 13]);
  expect(literalSizes('<text fontSize={11} /><text fontSize={wide.length > 1 ? 21 : 11.5} />')).toEqual([
    11, 21, 11.5,
  ]);
});

it('keeps every literal text size of the console at the 12 px floor', () => {
  const offenders = Object.entries(sources)
    .filter(([path]) => !path.includes('/test/'))
    .flatMap(([path, source]) =>
      literalSizes(source)
        .filter((size) => size < 12)
        .map((size) => `${path}: ${size}px`),
    );
  expect(Object.keys(sources).length).toBeGreaterThan(100);
  expect(offenders).toEqual([]);
});
