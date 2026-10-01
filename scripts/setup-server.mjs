import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const keys = ['DATABASE_URL', 'REDIS_URL', 'INTERNAL_API_TOKEN', 'CREDENTIAL_BROKER_TOKEN', 'CREDENTIAL_ENCRYPT_KEY'];
const secret = () => randomBytes(32).toString('hex');
const assets = new URL('./setup/', import.meta.url);
export function loadSetupEnvironment(directory, env) {
  const file = join(directory, 'bootstrap.json');
  if (!existsSync(file)) return { ...env };
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  if (saved.version !== 1 || !keys.every(key => typeof saved.environment?.[key] === 'string' && saved.environment[key])) {
    throw new Error('Invalid persisted setup configuration');
  }
  const result = { ...saved.environment, ...env };
  for (const [key, value] of Object.entries(saved.environment)) if (!env[key]) result[key] = value;
  return result;
}
export const needsSetup = env => keys.some(key => !env[key]);

function endpoint(input, kind) {
  if (typeof input?.url === 'string' && input.url.trim()) {
    const url = new URL(input.url.trim());
    if (!(kind === 'postgres' ? ['postgres:', 'postgresql:'] : ['redis:', 'rediss:']).includes(url.protocol) || !url.hostname || url.hash) throw new Error();
    return url.toString();
  }
  if (!input || typeof input.host !== 'string' || !/^[a-zA-Z0-9_.:[\]-]+$/.test(input.host) || !input.host.trim()) throw new Error();
  const port = Number(input.port ?? (kind === 'postgres' ? 5432 : 6379));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  const host = input.host.includes(':') && !input.host.startsWith('[') ? `[${input.host}]` : input.host;
  const url = new URL(`${kind === 'postgres' ? 'postgres' : input.tls ? 'rediss' : 'redis'}://${host}:${port}`);
  url.username = String(input.username || '');
  url.password = String(input.password || '');
  if (kind === 'postgres') {
    if (!input.username || !input.database) throw new Error();
    url.pathname = '/' + encodeURIComponent(String(input.database));
    if (input.tls) url.searchParams.set('sslmode', 'verify-full');
  } else {
    const database = Number(input.database || 0);
    if (!Number.isInteger(database) || database < 0 || database > 2147483647) throw new Error();
    url.pathname = '/' + database;
  }
  return url.toString();
}
export function setupCandidate(input, env) {
  if (!input || typeof input !== 'object') throw new Error('请填写连接参数。');
  let DATABASE_URL, REDIS_URL;
  try { DATABASE_URL = endpoint(input.postgres, 'postgres'); } catch { throw new Error('PostgreSQL 连接参数无效。'); }
  try { REDIS_URL = endpoint(input.redis, 'redis'); } catch { throw new Error('Redis 连接参数无效。'); }
  if (decodeURIComponent(new URL(DATABASE_URL).password) === 'mcp-dev-password') throw new Error('请为 PostgreSQL 设置生产环境密码。');
  if (typeof input.adminUsername !== 'string' || !/^[a-zA-Z0-9._-]{3,64}$/.test(input.adminUsername)) throw new Error('管理员账号须为 3–64 位字母、数字、点、下划线或连字符。');
  if (typeof input.adminPassword !== 'string' || input.adminPassword.length < 16 || input.adminPassword.length > 1024) throw new Error('管理员密码须为 16–1024 个字符。');
  for (const [key, value] of Object.entries({ DATABASE_URL, REDIS_URL, ADMIN_USERNAME: input.adminUsername, ADMIN_PASSWORD: input.adminPassword })) {
    if (env[key] && env[key] !== value) throw new Error('容器环境变量 ' + key + ' 已配置且优先，请移除该变量或填写一致的值。');
  }
  const value = { DATABASE_URL, REDIS_URL, ADMIN_USERNAME: input.adminUsername, ADMIN_PASSWORD: input.adminPassword,
    INTERNAL_API_TOKEN: env.INTERNAL_API_TOKEN || secret(), CREDENTIAL_BROKER_TOKEN: env.CREDENTIAL_BROKER_TOKEN || secret(),
    CREDENTIAL_ENCRYPT_KEY: env.CREDENTIAL_ENCRYPT_KEY || secret() };
  if (!/^[a-fA-F0-9]{64}$/.test(value.CREDENTIAL_ENCRYPT_KEY) || value.INTERNAL_API_TOKEN.length < 32 || value.CREDENTIAL_BROKER_TOKEN.length < 32 || value.INTERNAL_API_TOKEN === value.CREDENTIAL_BROKER_TOKEN) throw new Error('已提供的应用密钥无效，请检查容器环境变量。');
  return value;
}

export async function checkConnections(env) {
  // Resolve from the service's production dependencies, also usable in source checkouts.
  const require = createRequire(new URL('../packages/auth-server/package.json', import.meta.url));
  const { Client } = require('pg');
  const Redis = require('ioredis');
  const pg = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
  try {
    await pg.connect();
    await pg.query('BEGIN');
    // Rolled back: no persistent data is changed by the connection test.
    const schema = 'mcp_setup_' + randomBytes(8).toString('hex');
    await pg.query(`CREATE SCHEMA ${schema}`);
    await pg.query(`CREATE TABLE ${schema}.connection_check (value integer)`);
    await pg.query(`INSERT INTO ${schema}.connection_check VALUES (1)`);
    await pg.query(`SELECT value FROM ${schema}.connection_check`);
    await pg.query('ROLLBACK');
  } catch { throw new Error('PostgreSQL 连接失败或缺少建表权限。请检查地址、账号、数据库、TLS 和网络。'); }
  finally { await pg.end().catch(() => {}); }
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: 5000, commandTimeout: 5000, retryStrategy: () => null, maxRetriesPerRequest: 0 });
  redis.on('error', () => {});
  const key = 'mcp:setup-check:' + secret();
  try {
    await redis.connect();
    // Exercise the Lua permissions needed by session/rate-limit operations.
    const value = await redis.eval("redis.call('SET', KEYS[1], 'ok', 'EX', 15); local v=redis.call('GET', KEYS[1]); redis.call('DEL', KEYS[1]); return v", 1, key);
    if (value !== 'ok') throw new Error();
  } catch { throw new Error('Redis 连接或读写失败。请检查地址、密码、数据库编号、TLS、ACL 和网络。'); }
  finally { redis.disconnect(); }
}

export async function startSetupServer({ directory, env = process.env, port = 8080, host = '0.0.0.0', check = checkConnections, log = console.log }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tokenFile = join(directory, 'setup-token');
  let token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : secret();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid setup token');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
  let busy = false, installed = false, completedResolve;
  const completed = new Promise(resolve => { completedResolve = resolve; });
  let attempts = 0, windowStart = Date.now();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const path = req.url?.split('?')[0];
    if (req.method === 'GET') {
      if (path === '/healthz') return json(200, { ok: true, mode: 'setup', ready: false });
      const asset = { '/': ['index.html', 'text/html'], '/setup': ['index.html', 'text/html'], '/setup.js': ['setup.js', 'text/javascript'], '/setup.css': ['setup.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] }[path];
      if (!asset) return json(404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' });
      return res.end(readFileSync(new URL(asset[0], assets)));
    }
    if (req.method !== 'POST' || !['/setup/test', '/setup/install'].includes(path)) return json(404, { error: 'not_found' });
    if (installed) return json(409, { error: '配置已保存，请等待应用启动。' });
    // Browser Origin must match Host; CLI may omit Origin but still needs the secret.
    if (req.headers.origin) {
      try { const origin = new URL(req.headers.origin); if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host || origin.origin !== req.headers.origin) throw new Error(); }
      catch { return json(403, { error: '请求来源无效。' }); }
    }
    const supplied = Buffer.from(String(req.headers['x-setup-token'] || ''));
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, { error: '初始化密钥无效，请从容器日志获取。' });
    if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: '需要 JSON 请求。' });
    if (busy) return json(409, { error: '正在测试或保存，请稍后重试。' });
    if (Date.now() - windowStart > 60000) { attempts = 0; windowStart = Date.now(); }
    if (++attempts > 12) return json(429, { error: '操作过于频繁，请一分钟后重试。' });
    busy = true;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 16384) { json(413, { error: '请求过大。' }); return; } chunks.push(chunk); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(400, { error: '请求格式无效。' }); }
      let candidate;
      try { candidate = setupCandidate(input, env); } catch (error) { return json(400, { error: error.message }); }
      try { await check(candidate); } catch (error) { return json(422, { error: error.message }); }
      if (path === '/setup/test') return json(200, { ok: true, message: 'PostgreSQL 建表权限、Redis 读写测试通过。' });
      // A complete file is committed atomically. Preserve generated keys across restarts.
      const temporary = join(directory, 'bootstrap-' + secret() + '.tmp');
      writeFileSync(temporary, JSON.stringify({ version: 1, environment: candidate }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, join(directory, 'bootstrap.json'));
      installed = true;
      unlinkSync(tokenFile);
      token = '';
      res.once('finish', () => { server.close(() => completedResolve({ ...env, ...candidate })); server.closeIdleConnections(); });
      json(201, { ok: true, message: '配置已保存，正在启动应用。' });
      log('[setup] configuration saved; starting application');
    } catch { json(500, { error: '保存失败，请检查持久化目录的写入权限和剩余空间。' }); }
    finally { busy = false; }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.timeout = 20000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  log('[setup] open the application URL to configure PostgreSQL and Redis');
  log(`[setup] initialization key: ${token}`);
  return { server, completed, token, address: server.address() };
}

export async function prepareEnvironment(env) {
  const directory = env.MCP_DATA_DIR || '/app/data';
  const merged = loadSetupEnvironment(directory, env);
  if (!needsSetup(merged)) return merged;
  const setup = await startSetupServer({ directory, env: merged });
  return setup.completed;
}
