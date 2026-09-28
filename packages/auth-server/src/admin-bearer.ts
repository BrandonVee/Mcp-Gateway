/** OAuth tokens may administer production only for explicitly trusted clients. */
export function trustedAdminBearerClient(clientId: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true;
  if (typeof clientId !== 'string') return false;
  return (env.ADMIN_BEARER_CLIENT_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean).includes(clientId);
}
