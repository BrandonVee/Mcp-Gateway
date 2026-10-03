import { readFile } from 'node:fs/promises';

const repository = 'brandonvee/mcp-gateway';
const request = async (path, options = {}) => {
  const response = await fetch(`https://hub.docker.com${path}`, {
    ...options,
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Docker Hub request failed (${response.status})`);
  return response.json();
};
try {
  const secret = process.env.DOCKERHUB_TOKEN;
  if (!secret) throw new Error('DOCKERHUB_TOKEN is required with Read & Write permissions');
  // Release runs copy this script out of the checkout; allow an explicit path.
  const full_description = await readFile(
    process.env.MCP_DOCKERHUB_DOC ?? new URL('../docs/dockerhub.md', import.meta.url),
    'utf8',
  );
  if (!full_description.trim() || full_description.length > 25000)
    throw new Error('Docker Hub overview must contain 1–25000 characters');
  const { access_token } = await request('/v2/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'brandonvee', secret }),
  });
  if (!access_token) throw new Error('Docker Hub did not return an access token');
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${access_token}`);
  await request(`/v2/repositories/${repository}/`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({
      description: 'MCP Gateway: OAuth, access control and monitoring. Browser setup for PostgreSQL and Redis.',
      full_description,
    }),
  });
  const saved = await request(`/v2/repositories/${repository}/`);
  if (saved.full_description !== full_description) throw new Error('Docker Hub overview verification failed');
  console.log(`Updated and verified Docker Hub overview: ${repository}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
