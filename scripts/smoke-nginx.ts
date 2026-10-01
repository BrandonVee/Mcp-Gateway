/** Exercise production ingress in isolated containers, without application data. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const image = process.env.NGINX_TEST_IMAGE ?? readFileSync('Dockerfile.production', 'utf8')
  .match(/^FROM (\S+) AS admin-web$/m)?.[1];
assert.ok(image, 'Set NGINX_TEST_IMAGE or provide the production Nginx image');
const prefix = `mcp-nginx-test-${randomUUID()}`;
const directory = mkdtempSync(join(tmpdir(), prefix));
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
const cleanup = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 15_000 });
const html = '<!doctype html><html><body>' + 'static-page '.repeat(300) + '</body></html>';
const js = 'export const asset = ' + JSON.stringify('content-hashed '.repeat(300)) + ';';
const authBody = 'auth '.repeat(300), gatewayBody = 'gateway '.repeat(300);
const variants = [
  ['app', 'nginx-app-main.conf', 'nginx-app.conf'],
  ['admin', 'nginx-main.conf', 'nginx-admin.conf'],
  ['legacy', 'nginx-main.conf', 'nginx-single-host.conf'],
];

async function main() {
  chmodSync(directory, 0o755); // Nginx workers must be able to read the fixtures.
  mkdirSync(join(directory, 'html', 'assets'), { recursive: true });
  writeFileSync(join(directory, 'html', 'index.html'), html);
  writeFileSync(join(directory, 'html', 'assets', 'main-abcd1234.js'), js);
  // These upstreams exist only inside the test container; no real API is called.
  writeFileSync(join(directory, 'upstreams.conf'), `
    server { listen 9001; default_type text/html; return 200 ${JSON.stringify(authBody)}; }
    server { listen 8000; default_type text/html; return 200 ${JSON.stringify(gatewayBody)}; }
    server { listen 9002; return 200 '{"ok":true}'; }
  `);
  docker(['network', 'create', prefix]);
  try {
    for (const [variant, mainFile, serverFile] of variants) {
      const name = `${prefix}-${variant}`;
      const variantDirectory = join(directory, variant);
      mkdirSync(variantDirectory);
      const config = readFileSync(`deploy/${mainFile}`, 'utf8').replace(
        /^\s*include (?:\/app\/deploy\/nginx-app\.conf|\/etc\/nginx\/conf\.d\/\*\.conf);$/m,
        '    include /test/server.conf;\n    include /test/upstreams.conf;',
      );
      writeFileSync(join(variantDirectory, 'nginx.conf'), config);
      writeFileSync(join(variantDirectory, 'server.conf'), readFileSync(`deploy/${serverFile}`, 'utf8'));
      writeFileSync(join(variantDirectory, 'upstreams.conf'), readFileSync(join(directory, 'upstreams.conf')));
      try {
        docker(['run', '-d', '--name', name, '--network', prefix,
          '--network-alias', 'auth', '--network-alias', 'gateway',
          '-p', '127.0.0.1::8080', '--read-only', '--tmpfs', '/tmp',
          '-v', `${variantDirectory}:/test:ro`, '-v', `${join(directory, 'html')}:/usr/share/nginx/html:ro`,
          '--entrypoint', 'nginx', image!, '-c', '/test/nginx.conf', '-g', 'daemon off;']);
        docker(['exec', name, 'nginx', '-t', '-c', '/test/nginx.conf']);
        const address = docker(['port', name, '8080/tcp']);
        const base = `http://${address}`;
        const request = (path: string) => fetch(base + path, {
          headers: { 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(5000),
        });
        for (let attempt = 0; attempt < 30; attempt++) {
          try { const response = await request('/'); await response.arrayBuffer(); if (response.ok) break; }
          catch { /* Nginx may still be starting. */ }
          if (attempt === 29) assert.fail(`${variant}: Nginx did not start`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        for (const path of ['/', '/index.html', '/connections']) {
          const response = await request(path);
          assert.equal(response.status, 200, `${variant}: ${path}`);
          assert.match(response.headers.get('cache-control') ?? '', /no-cache/);
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
          assert.equal(response.headers.get('x-frame-options'), 'DENY');
          assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
          assert.equal(response.headers.get('content-encoding'), 'gzip');
          assert.equal(await response.text(), html);
        }
        const asset = await request('/assets/main-abcd1234.js');
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get('cache-control') ?? '', /max-age=31536000/);
        assert.equal(asset.headers.get('content-encoding'), 'gzip');
        assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(await asset.text(), js);
        for (const path of ['/assets/removed-chunk.js', '/api/internal/servers', '/gateway/mcp/test']) {
          const response = await request(path);
          assert.equal(response.status, 404, `${variant}: ${path}`);
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
          await response.arrayBuffer();
        }
        const api = await request('/api/check.js?code=PRIVATE_OAUTH_CODE&state=PRIVATE_STATE');
        assert.equal(api.status, 200);
        assert.equal(api.headers.get('content-encoding'), null, 'Do not compress authenticated responses');
        assert.equal(api.headers.get('cache-control'), null, 'Do not cache API responses as assets');
        assert.equal(await api.text(), authBody);
        if (variant !== 'admin') {
          const mcp = await request('/mcp/tool.js');
          assert.equal(mcp.status, 200);
          assert.equal(mcp.headers.get('content-encoding'), null);
          assert.equal(await mcp.text(), gatewayBody);
        }
        const logs = docker(['logs', name]);
        assert.match(logs, /\/check\.js/);
        assert.ok(!logs.includes('PRIVATE_OAUTH_CODE') && !logs.includes('PRIVATE_STATE'), 'OAuth query values must not be logged');
        console.log(`PASS: ${variant} ingress, SPA routes, asset 404/cache/gzip, security headers and private query logging`);
      } catch (error) {
        const logs = cleanup(['logs', name]);
        console.error(logs.stdout, logs.stderr);
        throw error;
      } finally { cleanup(['rm', '-f', name]); }
    }
  } finally { cleanup(['network', 'rm', prefix]); }
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => rmSync(directory, { recursive: true, force: true }));
