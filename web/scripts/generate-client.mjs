import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const input = process.argv[2] || fileURLToPath(new URL('../../work/openapi.json', import.meta.url));
const schema = JSON.parse(await readFile(input, 'utf8'));
const types = await openapiTS(schema);
await writeFile(new URL('../src/api-schema.d.ts', import.meta.url), astToString(types), 'utf8');
