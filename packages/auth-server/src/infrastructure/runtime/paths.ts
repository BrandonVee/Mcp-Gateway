import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// esbuild retains import.meta.url at the bundled dist/index.js entrypoint.
const directory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(directory, basename(directory) === 'dist' ? '..' : '../../..');
export const authServerPaths = { migrations: resolve(packageRoot, 'drizzle') } as const;
