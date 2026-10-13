import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

// A single process can import multiple packages. Aliases must never depend on the importer's cwd.
test('tsx resolves the same package aliases from the root and every workspace', async () => {
  const source = `
    import assert from 'node:assert/strict';
    import { createPkceAuthorization } from '@/auth/shared/security/pkce.js';
    import { filterRequestHeaders } from '@/gateway/routes/headers.js';
    import { isValidApiKey } from '@/shared/security/credentials.js';
    import { validationRule } from '@/web/utils/validation';
    assert.equal(createPkceAuthorization().verifier.length, 43);
    assert.deepEqual(filterRequestHeaders({ authorization: 'private', accept: 'application/json' }), { accept: 'application/json' });
    assert.equal(isValidApiKey('key'), true);
    await validationRule(isValidApiKey, 'invalid').validator(undefined, 'key');
  `;
  for (const directory of [
    '',
    'packages/auth-server',
    'packages/gateway',
    'packages/shared',
    'packages/admin-web',
    'tests/fixtures',
  ]) {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: `${root}${directory}`,
      timeout: 15000,
      env: { ...process.env, TSX_TSCONFIG_PATH: undefined },
    });
    assert.equal(result.stderr, '', directory || 'workspace root');
  }
});
