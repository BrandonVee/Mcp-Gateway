import { upstreamProbeDraft, sameUpstreamProbeDraft, type UpstreamProbeDraft } from './upstream-probe-draft';
import { ApiOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useI18n, type MessageKey } from '../../i18n';
import type { SystemSettings, UpstreamTestResult, UpstreamTestAuthInput } from '../../types';
import { isEndpointUrl } from '../../utils/validation';
import { untrustedUpstreamHost } from './upstream-allowlist';

const resultMessages: Record<UpstreamTestResult['reason'], MessageKey> = {
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
  response_too_large: 'mcpTest.responseTooLarge',
  gateway_unavailable: 'mcpTest.gatewayUnavailable',
  busy: 'mcpTest.busy',
};

export function loopbackUpstreamEndpoint(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host.startsWith('127.');
  } catch {
    return false;
  }
}

export function UpstreamConnectionTest({
  settings,
  onTestUpstream,
  busy,
  instanceId,
}: {
  settings: SystemSettings | null;
  onTestUpstream: (
    url: string,
    signal?: AbortSignal,
    authentication?: UpstreamTestAuthInput,
  ) => Promise<UpstreamTestResult>;
  busy: boolean;
  instanceId?: string;
}) {
  const { t } = useI18n();
  const form = Form.useFormInstance();
  const value = Form.useWatch('url');
  const authMode = Form.useWatch('auth_mode') as UpstreamTestAuthInput['auth_mode'];
  const systemKey = Form.useWatch('system_api_key');
  const keyHeader = Form.useWatch('api_key_header');
  const keyPrefix = Form.useWatch('api_key_prefix');
  const url = typeof value === 'string' ? value.trim() : '';
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<UpstreamTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const activeDraft = useRef<UpstreamProbeDraft | null>(null);

  useEffect(() => {
    const current = upstreamProbeDraft(form.getFieldsValue(true), instanceId);
    // A delayed useWatch render must not cancel a probe already using those exact values.
    if (activeDraft.current && sameUpstreamProbeDraft(activeDraft.current, current)) return;
    activeDraft.current = null;
    attempt.current++;
    abort.current?.abort();
    setTesting(false);
    setResult(null);
    setError(null);
  }, [url, authMode, systemKey, keyHeader, keyPrefix, instanceId, form]);

  useEffect(
    () => () => {
      attempt.current++;
      abort.current?.abort();
    },
    [],
  );

  const test = async () => {
    const id = ++attempt.current;
    const draft = upstreamProbeDraft(form.getFieldsValue(true), instanceId);
    activeDraft.current = draft;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setTesting(true);
    setResult(null);
    setError(null);
    try {
      const response = await onTestUpstream(draft.url, controller.signal, draft.authentication);
      if (
        attempt.current === id &&
        sameUpstreamProbeDraft(draft, upstreamProbeDraft(form.getFieldsValue(true), instanceId))
      )
        setResult(response);
    } catch (failure) {
      if (
        attempt.current === id &&
        sameUpstreamProbeDraft(draft, upstreamProbeDraft(form.getFieldsValue(true), instanceId))
      )
        setError(failure instanceof Error ? failure.message : t('common.operationFailed'));
    } finally {
      if (attempt.current === id) setTesting(false);
    }
  };

  return (
    <div className="upstream-connection-test">
      {loopbackUpstreamEndpoint(url) && (
        <Alert type="info" showIcon message={t('mcpTest.loopbackTitle')} description={t('mcpTest.loopbackHelp')} />
      )}
      <div className="upstream-test-actions">
        <Button
          icon={<ApiOutlined />}
          loading={testing}
          disabled={busy || !isEndpointUrl(url) || Boolean(untrustedUpstreamHost(url, settings))}
          onClick={() => void test()}
        >
          {t('mcpTest.action')}
        </Button>
        <Typography.Text type="secondary">{t('mcpTest.help')}</Typography.Text>
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      {result && (
        <Alert
          showIcon
          type={result.ok ? 'success' : result.reason === 'auth_required' ? 'warning' : 'error'}
          message={result.ok ? t('mcpTest.success') : t('mcpTest.failed')}
          description={
            <div className="upstream-test-result" role="status">
              {!result.ok && <span>{t(resultMessages[result.reason], { status: result.http_status ?? '—' })}</span>}
              {result.server && (
                <span>{t('mcpTest.server', { name: result.server.name, version: result.server.version })}</span>
              )}
              {result.tools_count !== null && <span>{t('mcpTest.tools', { count: result.tools_count })}</span>}
              <span>{t('mcpTest.duration', { duration: result.duration_ms })}</span>
              {result.ok && <span>{t('mcpTest.scope')}</span>}
            </div>
          }
        />
      )}
    </div>
  );
}
