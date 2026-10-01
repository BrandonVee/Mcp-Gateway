/** Rehearse the former five-container topology -> unified app, on CI data only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { readDeploymentEnvironment } from './deploy-env.js';

const directory=process.env.MCP_DEPLOY_DIR;
if (!directory || !process.env.COMPOSE_PROJECT_NAME?.includes('ci')) throw new Error('Use a disposable CI deployment');
const envFile=resolve(directory,'runtime.env'),configFile=resolve(directory,'config.json'),before=readDeploymentEnvironment(envFile);
const compose=['compose','--env-file',envFile,'-f','deploy/compose.single-host.yml'];
const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:60000}).trim();
const id=(service:string)=>docker([...compose,'ps','-q',service]);
const sql=(query:string)=>execFileSync('docker',[...compose,'exec','-T','postgres','psql','-U','mcp','-d','mcp','-At','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8'}).trim();
async function main() {
  const pg=id('postgres'),redis=id('redis');
  const users=sql('SELECT count(*) FROM users;'),signing=sql("SELECT md5(value) FROM meta WHERE key='signing_pem';");
  assert.ok(pg && redis, 'data containers must exist before the upgrade');
  assert.ok(Number(users) > 0 && signing, 'existing users and signing key must be present');
  sql('CREATE TABLE upgrade_rehearsal(value integer); INSERT INTO upgrade_rehearsal VALUES(987);');
  const image=docker(['inspect','--format','{{.Config.Image}}',id('app')]);
  docker([...compose,'stop','app']);docker([...compose,'rm','-f','app']);
  const config=JSON.parse(readFileSync(configFile,'utf8'));
  config.gateway.authJwksUrl='http://auth:9001/jwks.json';config.gateway.registryUrl='http://auth:9001/internal/mcp-servers';
  writeFileSync(configFile,JSON.stringify(config));
  const common={image,read_only:true,tmpfs:['/tmp'],networks:['control'],volumes:[`${configFile}:/app/config/production.json:ro`],
    environment:{NODE_ENV:'production',SYSTEM_CONFIG_MODE:'database',CONFIG_FILE:'/app/config/production.json',
      DATABASE_URL:`postgres://mcp:${before.POSTGRES_PASSWORD}@postgres:5432/mcp`,REDIS_URL:`redis://:${before.REDIS_PASSWORD}@redis:6379/0`,
      INTERNAL_API_TOKEN:before.INTERNAL_API_TOKEN,CREDENTIAL_BROKER_TOKEN:before.CREDENTIAL_BROKER_TOKEN,
      CREDENTIAL_ENCRYPT_KEY:before.CREDENTIAL_ENCRYPT_KEY,ADMIN_PASSWORD:before.ADMIN_PASSWORD}};
  // Run the packaged services separately with the former DNS names and ingress.
  const legacyFile=resolve(directory,'legacy-topology.json');
  writeFileSync(legacyFile,JSON.stringify({services:{
    auth:{...common,entrypoint:['node'],command:['/app/packages/auth-server/dist/index.js']},
    gateway:{...common,entrypoint:['node'],command:['/app/packages/gateway/dist/index.js']},
    'admin-web':{image,read_only:true,tmpfs:['/tmp'],networks:['control'],entrypoint:['nginx'],command:['-g','daemon off;'],
      ports:[`127.0.0.1:${before.MCP_HTTP_PORT}:8080`],volumes:[`${resolve('deploy/nginx-main.conf')}:/etc/nginx/nginx.conf:ro`,`${resolve('deploy/nginx-single-host.conf')}:/etc/nginx/conf.d/default.conf:ro`]},
  },networks:{control:{external:true,name:`${before.COMPOSE_PROJECT_NAME}_control`}}}),{mode:0o600});
  try {
    docker(['compose','-p',before.COMPOSE_PROJECT_NAME,'-f',legacyFile,'up','-d']);
    let legacyReady=false;
    for(let i=0;i<80;i++) {
      try {if((await fetch(`http://127.0.0.1:${before.MCP_HTTP_PORT}/gateway/health`)).ok){legacyReady=true;break;}}catch{}
      await new Promise(done=>setTimeout(done,250));
    }
    assert.ok(legacyReady,'legacy services must be running before the upgrade');
    execFileSync('bash',['scripts/deploy.sh','--yes'],{env:{...process.env,MCP_VERSION:before.MCP_VERSION},stdio:'pipe',timeout:180000});
    assert.equal(id('postgres'),pg);assert.equal(id('redis'),redis);
    assert.equal(sql('SELECT value FROM upgrade_rehearsal;'),'987');
    assert.equal(sql('SELECT count(*) FROM users;'),users);
    assert.equal(sql("SELECT md5(value) FROM meta WHERE key='signing_pem';"),signing);
    const after=readDeploymentEnvironment(envFile);
    for(const key of ['POSTGRES_PASSWORD','REDIS_PASSWORD','INTERNAL_API_TOKEN','CREDENTIAL_BROKER_TOKEN','CREDENTIAL_ENCRYPT_KEY','ADMIN_PASSWORD']) assert.equal(after[key],before[key]);
    const services=docker([...compose,'ps','--all','--format','{{.Service}}']).split('\n').sort();
    assert.deepEqual(services,['app','postgres','redis']);
    assert.equal((await fetch(`http://127.0.0.1:${before.MCP_HTTP_PORT}/healthz`)).status,200);
    sql('DROP TABLE upgrade_rehearsal;');
    console.log('PASS: five-container upgrade preserves database/Redis containers, users, signing key, data and deployment secrets; only three containers remain');
  } finally { unlinkSync(legacyFile); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
