/** Exercise the one-command deployment against a disposable Compose project. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { getAccessToken } from './oauth-token.js';
import { readDeploymentEnvironment } from './deploy-env.js';

async function main() {
  const directory = process.env.MCP_DEPLOY_DIR;
  if (!directory) throw new Error('Set MCP_DEPLOY_DIR to the disposable deployment directory');
  const envFile = resolve(directory, 'runtime.env');
  const readEnv = () => readDeploymentEnvironment(envFile);
  const saved = readEnv();
  const base = `http://127.0.0.1:${saved.MCP_HTTP_PORT}`;
  const originalUrl = 'https://setup.example.test';
  const updatedUrl = 'https://changed.example.test';
  let cookie = '';
  const request = async (path: string, method = 'GET', body?: unknown, origin = originalUrl, bearer?: string) => {
    return await new Promise<{ response: { status: number; headers: Headers }; data: any; text: string }>((done, reject) => {
      const outgoing = httpRequest(`${base}${path}`, { method, headers: {
        host: new URL(originalUrl).host, origin,
        ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      } }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          let data: any = {};
          try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* HTML 404 or empty response. */ }
          done({ response: { status: incoming.statusCode!, headers }, data, text:Buffer.concat(chunks).toString() });
        });
      });
      outgoing.on('error', reject);
      outgoing.end(body ? JSON.stringify(body) : undefined);
    });
  };
  for (const path of ['/authorize', '/token', '/register', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/mcp/example']) {
    const post = ['/token', '/register'].includes(path);
    const { response } = await request(path, post ? 'POST' : 'GET', post ? {} : undefined);
    assert.equal(response.status, 503, `${path} stays closed before setup`);
  }
  assert.equal((await request('/api/admin/system-settings')).response.status, 403);
  const credentials = { username: 'admin', password: saved.ADMIN_PASSWORD };
  assert.equal((await request('/api/admin/session', 'POST', credentials, 'https://attacker.example.test')).response.status, 403);
  const login = await request('/api/admin/session', 'POST', credentials);
  assert.equal(login.response.status, 200);
  const setCookie = login.response.headers.get('set-cookie')!;
  assert.ok(setCookie.includes('Secure') && setCookie.includes('HttpOnly'));
  cookie = setCookie.split(';')[0];
  for (const path of ['/api/admin/users', '/api/admin/servers', '/api/admin/connections', '/gateway/health']) {
    assert.equal((await request(path)).response.status, 200, `${path} is available during initial setup`);
  }
  assert.equal((await request('/api/admin/system-settings')).data.configured, false);
  assert.equal((await request('/api/admin/system-settings', 'PUT', { public_url: 'http://setup.example.test', upstream_hosts: [] })).response.status, 400);
  assert.equal((await request('/api/admin/system-settings', 'PUT', { public_url: originalUrl, upstream_hosts: ['upstream.example.test'] })).response.status, 200);
  assert.equal((await request('/.well-known/oauth-authorization-server')).data.issuer, originalUrl);
  assert.equal((await request('/.well-known/oauth-protected-resource')).data.resource, originalUrl);
  assert.equal((await request('/internal/mcp-servers')).response.status, 404);
  assert.equal((await request('/api/internal/mcp-servers')).response.status, 404);

  const registration = await request('/register','POST',{redirect_uris:['http://127.0.0.1:55945/oauth/callback']});
  assert.equal(registration.response.status,201);
  const signupQuery=new URLSearchParams({response_type:'code',client_id:registration.data.client_id,redirect_uri:'http://127.0.0.1:55945/oauth/callback',code_challenge:'a'.repeat(43),code_challenge_method:'S256'});
  assert.equal((await request('/api/admin/system-settings','PUT',{public_url:originalUrl,upstream_hosts:[],registration_enabled:false})).response.status,200);
  const adminCookie=cookie;cookie='';
  assert.equal((await request('/authorize/signup?'+signupQuery)).response.status,403);
  assert.equal((await request('/authorize?'+signupQuery)).text.includes('/authorize/signup'),false);
  const blockedSignup=await fetch(base+'/authorize/signup',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:originalUrl},body:signupQuery});
  assert.equal(blockedSignup.status,403);
  cookie=adminCookie;
  assert.equal((await request('/api/admin/system-settings','PUT',{public_url:originalUrl,upstream_hosts:[],registration_enabled:true})).response.status,200);
  cookie='';assert.equal((await request('/authorize/signup?'+signupQuery)).response.status,200);cookie=adminCookie;
  console.log('PASS: registration switch gates GET/POST, hides signup, and preserves existing login');

  process.env.AUTH_URL = base;
  process.env.MCP_USER = 'admin';
  process.env.MCP_PASSWORD = saved.ADMIN_PASSWORD;
  const tokens = await getAccessToken();
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
  assert.equal(claims.iss, originalUrl);
  assert.equal((await request('/servers', 'GET', undefined, originalUrl, tokens.access_token)).response.status, 200);
  assert.equal((await request('/api/admin/system-settings', 'PUT', { public_url: updatedUrl, upstream_hosts: ['upstream.example.test'] })).response.status, 200);
  assert.equal((await request('/mcp/example', 'OPTIONS', undefined, updatedUrl)).response.status, 204);
  assert.equal((await request('/.well-known/oauth-protected-resource')).data.resource, updatedUrl);
  assert.equal((await request('/.well-known/oauth-authorization-server')).data.issuer, updatedUrl);
  assert.equal((await request('/servers', 'GET', undefined, updatedUrl, tokens.access_token)).response.status, 401);
  assert.equal((await request('/api/admin/system-settings', 'PUT', { public_url: originalUrl, upstream_hosts: [] }, 'https://attacker.example.test')).response.status, 403);

  execFileSync('docker', ['compose', '--env-file', envFile, '-f', 'deploy/compose.single-host.yml', 'restart', 'auth', 'gateway'], { stdio: 'pipe' });
  let restored = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const [auth, gateway] = await Promise.all([
        request('/.well-known/oauth-authorization-server'), request('/.well-known/oauth-protected-resource'),
      ]);
      restored = auth.data.issuer === updatedUrl && gateway.data.resource === updatedUrl;
      if (restored) break;
    } catch { /* Containers are restarting. */ }
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.ok(restored, 'system URL persists across container restarts');
  assert.equal((await request('/api/admin/system-settings', 'GET', undefined, updatedUrl)).data.public_url, updatedUrl);
  execFileSync('bash', ['scripts/deploy.sh', '--yes', '--prepare-only'], { stdio: 'pipe' });
  const after = readEnv();
  for (const key of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'INTERNAL_API_TOKEN', 'CREDENTIAL_BROKER_TOKEN', 'CREDENTIAL_ENCRYPT_KEY', 'ADMIN_PASSWORD']) {
    assert.ok(after[key] === saved[key], `${key} persists across repeat deployment`);
  }
  assert.equal(after.PUBLIC_URL, undefined);
  console.log('PASS: initial setup, browser origin checks, OAuth and MCP discovery, JWT issuer change, restart persistence, stable deployment secrets');
}

main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
