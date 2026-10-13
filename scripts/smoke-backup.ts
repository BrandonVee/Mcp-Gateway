/** Backup/restore rehearsal for a disposable one-command deployment only. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, statSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { readDeploymentEnvironment } from '@/scripts/deploy-env.js';
const directory = process.env.MCP_DEPLOY_DIR;
if (!directory || !process.env.COMPOSE_PROJECT_NAME?.includes('ci')) throw new Error('Use a disposable CI deployment');
const envFile = resolve(directory, 'runtime.env'),
  saved = readDeploymentEnvironment(envFile);
const compose = ['compose', '--env-file', envFile, '-f', 'deploy/compose.single-host.yml'];
const sql = (query: string) =>
  execFileSync(
    'docker',
    [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'mcp', '-d', 'mcp', '-v', 'ON_ERROR_STOP=1', '-At'],
    { input: query, encoding: 'utf8' },
  ).trim();
const backupDir = mkdtempSync(join(tmpdir(), 'mcp-backup-rehearsal-'));
try {
  sql('CREATE TABLE backup_rehearsal(value integer); INSERT INTO backup_rehearsal VALUES(1);');
  // Backups from the former split containers must remain restorable.
  const configFile = resolve(directory, 'config.json'),
    config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.gateway.authJwksUrl = 'http://auth:9001/jwks.json';
  config.gateway.registryUrl = 'http://auth:9001/internal/mcp-servers';
  writeFileSync(configFile, JSON.stringify(config));
  // Earlier backups did not record the image name. Restoring them must retain
  // the currently selected repository rather than switching back to mcp-app.
  const originalEnv = readFileSync(envFile, 'utf8');
  let output: string;
  try {
    writeFileSync(envFile, originalEnv.replace(/^MCP_IMAGE_NAME=.*\n/m, ''));
    output = execFileSync('bash', ['scripts/backup.sh'], {
      env: { ...process.env, MCP_BACKUP_DIR: backupDir },
      encoding: 'utf8',
    });
  } finally {
    writeFileSync(envFile, originalEnv);
  }
  const archive = output.trim().split('：').at(-1)!;
  assert.equal(statSync(archive).mode & 0o777, 0o600);
  sql('UPDATE backup_rehearsal SET value=2;');
  const damaged = join(backupDir, 'damaged.tar.gz');
  writeFileSync(damaged, 'not an archive');
  assert.notEqual(
    spawnSync('bash', ['scripts/restore.sh', '--confirm', damaged], { env: process.env, encoding: 'utf8' }).status,
    0,
  );
  assert.equal(sql('SELECT value FROM backup_rehearsal;'), '2', 'invalid backup must not modify data');
  const tampered = join(backupDir, 'tampered');
  mkdirSync(tampered);
  execFileSync('tar', ['-xzf', archive, '-C', tampered]);
  appendFileSync(join(tampered, 'database.dump'), 'corruption');
  const corrupted = join(backupDir, 'corrupted.tar.gz');
  execFileSync('tar', ['-czf', corrupted, '-C', tampered, 'database.dump', 'runtime.env', 'config.json', 'sha256.txt']);
  const rejection = spawnSync('bash', ['scripts/restore.sh', '--confirm', corrupted], {
    env: process.env,
    encoding: 'utf8',
  });
  assert.notEqual(rejection.status, 0);
  assert.match(rejection.stderr, /校验失败/);
  assert.equal(sql('SELECT value FROM backup_rehearsal;'), '2', 'checksum failure must not modify data');
  writeFileSync(
    envFile,
    readFileSync(envFile, 'utf8').replace(/^CREDENTIAL_ENCRYPT_KEY=.*$/m, 'CREDENTIAL_ENCRYPT_KEY=' + 'f'.repeat(64)),
  );
  execFileSync('bash', ['scripts/restore.sh', '--confirm', archive], { env: process.env, stdio: 'pipe' });
  assert.equal(sql('SELECT value FROM backup_rehearsal;'), '1');
  assert.equal(readDeploymentEnvironment(envFile).CREDENTIAL_ENCRYPT_KEY, saved.CREDENTIAL_ENCRYPT_KEY);
  assert.equal(readDeploymentEnvironment(envFile).MCP_VERSION, saved.MCP_VERSION);
  assert.equal(readDeploymentEnvironment(envFile).MCP_IMAGE_NAME, saved.MCP_IMAGE_NAME);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).gateway.registryUrl, config.gateway.registryUrl);
  sql('DROP TABLE backup_rehearsal;');
  console.log(
    'PASS: backup permissions, invalid archive/checksum rejection, database restore, encryption-key restore and application restart',
  );
} finally {
  rmSync(backupDir, { recursive: true, force: true });
}
