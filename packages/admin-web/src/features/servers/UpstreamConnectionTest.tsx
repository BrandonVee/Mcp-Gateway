import {
  upstreamProbeDraft,
  sameUpstreamProbeDraft,
  type UpstreamProbeDraft,
} from '@/web/features/servers/upstream-probe-draft';
import { ApiOutlined, CheckCircleFilled } from '@ant-design/icons';
import { Alert, Button, Form, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/web/i18n';
import { UpstreamTestDetails } from '@/web/features/servers/UpstreamTestDetails';
import type { SystemSettings, UpstreamTestResult, UpstreamTestAuthInput } from '@/web/types';
import { isEndpointUrl } from '@/shared/security/urls.js';
import { untrustedUpstreamHost } from '@/web/features/servers/upstream-allowlist';

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
      <div className="upstream-test-actions">
        <Button
          icon={<ApiOutlined />}
          loading={testing}
          disabled={busy || !isEndpointUrl(url) || Boolean(untrustedUpstreamHost(url, settings))}
          onClick={() => void test()}
        >
          {t('mcpTest.action')}
        </Button>
        {result?.ok && (
          <div className="upstream-test-outcome" role="status">
            <span className="upstream-test-success">
              <CheckCircleFilled aria-hidden />
              {t('mcpTest.success')}
            </span>
            <Typography.Text className="upstream-test-duration" type="secondary">
              {t('mcpTest.duration', { duration: result.duration_ms })}
            </Typography.Text>
          </div>
        )}
      </div>
      {!result && !error && (
        <Typography.Text className="upstream-test-help" type="secondary">
          {t('mcpTest.help')}
        </Typography.Text>
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {result?.ok ? (
        <UpstreamTestDetails result={result} showDuration={false} />
      ) : result ? (
        <Alert
          showIcon
          type={result.reason === 'auth_required' ? 'warning' : 'error'}
          message={t('mcpTest.failed')}
          description={<UpstreamTestDetails result={result} />}
        />
      ) : null}
    </div>
  );
}
