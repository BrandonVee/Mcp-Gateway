import type { MessageKey } from '@/web/i18n';
import type { UpstreamTestResult } from '@/web/types';

export const upstreamTestMessages: Record<UpstreamTestResult['reason'], MessageKey> = {
  ok: 'mcpTest.success',
  dns: 'mcpTest.dns',
  connection_refused: 'mcpTest.connectionRefused',
  timeout: 'mcpTest.timeout',
  tls: 'mcpTest.tls',
  network: 'mcpTest.network',
  http: 'mcpTest.http',
  not_found: 'mcpTest.notFound',
  method_not_allowed: 'mcpTest.methodNotAllowed',
  auth_required: 'mcpTest.authRequired',
  access_denied: 'mcpTest.accessDenied',
  redirect: 'mcpTest.redirect',
  invalid_mcp: 'mcpTest.invalidMcp',
  tools_failed: 'mcpTest.toolsFailed',
  resources_failed: 'mcpTest.resourcesFailed',
  prompts_failed: 'mcpTest.promptsFailed',
  response_too_large: 'mcpTest.responseTooLarge',
  gateway_unavailable: 'mcpTest.gatewayUnavailable',
  busy: 'mcpTest.busy',
};
