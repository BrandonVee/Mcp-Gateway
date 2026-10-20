import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, Table, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { apiForSession } from '@/web/api';
import type { UserApiKey } from '@/web/types';
import { FormModal } from '@/web/components/FormModal';
import { useI18n } from '@/web/i18n';

export function UserApiKeys({
  api,
  onError,
}: {
  api: ReturnType<typeof apiForSession>;
  onError: (error: unknown) => void;
}) {
  const { t, language } = useI18n();
  const { message, modal } = App.useApp();
  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setKeys((await api.myApiKeys()).keys);
    } catch (error) {
      onError(error);
      setError(error instanceof Error ? error.message : t('common.refreshFailed'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [api]);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.createMyApiKey(name.trim());
      setSecret(created.key);
      setCreating(false);
      setName('');
      await load();
    } catch (error) {
      onError(error);
      message.error(error instanceof Error ? error.message : t('common.operationFailed'));
    } finally {
      setBusy(false);
    }
  };
  const revoke = (key: UserApiKey) =>
    modal.confirm({
      title: t('keys.revokeTitle', { name: key.name }),
      content: t('keys.revokeHelp'),
      okText: t('keys.revoke'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          await api.revokeMyApiKey(key.id);
          await load();
        } catch (error) {
          onError(error);
          message.error(error instanceof Error ? error.message : t('common.operationFailed'));
          throw error;
        } finally {
          setBusy(false);
        }
      },
    });
  const date = (value: number | null) =>
    value === null
      ? '—'
      : new Intl.DateTimeFormat(language, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(value);
  return (
    <>
      <div className="connections-tab-toolbar">
        <div className="connections-tab-meta">
          <h1>{t('keys.title')}</h1>
        </div>
        <div className="connections-toolbar-actions">
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading} disabled={busy}>
            {t('common.refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)} disabled={busy || loading}>
            {t('keys.create')}
          </Button>
        </div>
      </div>
      <div className="connections-scroll-region user-api-keys">
        <Alert type="info" showIcon message={t('keys.help')} description={t('keys.authorizationHelp')} />
        {error && <Alert type="error" showIcon message={error} />}
        <Table<UserApiKey>
          rowKey="id"
          dataSource={keys}
          loading={loading}
          pagination={false}
          scroll={{ x: 640 }}
          locale={{ emptyText: t('keys.empty') }}
          columns={[
            { title: t('keys.name'), dataIndex: 'name', ellipsis: true },
            {
              title: t('keys.prefix'),
              dataIndex: 'prefix',
              render: (prefix: string) => <Typography.Text code>{prefix}…</Typography.Text>,
            },
            { title: t('keys.createdAt'), dataIndex: 'created_at', render: date },
            { title: t('keys.lastUsedAt'), dataIndex: 'last_used_at', render: date },
            {
              title: t('common.actions'),
              width: 88,
              render: (_, key) => (
                <Button type="text" danger icon={<DeleteOutlined />} onClick={() => revoke(key)} disabled={busy}>
                  {t('keys.revoke')}
                </Button>
              ),
            },
          ]}
        />
      </div>
      <FormModal
        open={creating}
        title={t('keys.create')}
        okText={t('keys.create')}
        cancelText={t('common.cancel')}
        onOk={create}
        onCancel={() => {
          setCreating(false);
          setName('');
        }}
        confirmLoading={busy}
        okButtonProps={{ disabled: !name.trim() }}
        closable={!busy}
        keyboard={!busy}
        maskClosable={!busy}
        cancelButtonProps={{ disabled: busy }}
      >
        <Form layout="vertical">
          <Form.Item label={t('keys.name')} required>
            <Input
              autoFocus
              value={name}
              maxLength={80}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onPressEnter={() => void create()}
              placeholder={t('keys.namePlaceholder')}
            />
          </Form.Item>
        </Form>
      </FormModal>
      <FormModal
        open={!!secret}
        title={t('keys.created')}
        onCancel={() => setSecret('')}
        footer={
          <Button type="primary" onClick={() => setSecret('')}>
            {t('common.close')}
          </Button>
        }
      >
        <Alert type="info" showIcon message={t('keys.once')} />
        <div className="api-key-secret">
          <Input.Password readOnly value={secret} aria-label={t('keys.title')} />
          <Button
            icon={<CopyOutlined />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(secret);
                message.success(t('keys.copied'));
              } catch {
                message.error(t('servers.copyFailed'));
              }
            }}
          >
            {t('keys.copy')}
          </Button>
        </div>
        <Typography.Text type="secondary">{t('keys.headerExample')}</Typography.Text>
      </FormModal>
    </>
  );
}
