import { Collapse, Tag } from 'antd';
import { useI18n } from '@/web/i18n';
import type { UpstreamTestResult } from '@/web/types';
import { upstreamTestMessages } from '@/web/features/servers/upstream-test-messages';

type CatalogEntry = {
  name: string;
  title?: string;
  description?: string;
  uri?: string;
  uriTemplate?: string;
  mimeType?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
};

function CatalogList({ entries, unread }: { entries: CatalogEntry[] | null; unread: boolean }) {
  const { t } = useI18n();
  if (!entries || entries.length === 0)
    return (
      <p className="upstream-catalog-empty">
        {t(entries === null ? (unread ? 'mcpTest.notRead' : 'mcpTest.notProvided') : 'mcpTest.emptyList')}
      </p>
    );
  return (
    <ul className="upstream-catalog-list">
      {entries.map((entry, index) => (
        <li key={entry.uri ?? entry.uriTemplate ?? `${entry.name}:${index}`}>
          <div className="upstream-catalog-name">
            <code>{entry.name}</code>
            {entry.title && entry.title !== entry.name && <span>{entry.title}</span>}
          </div>
          {entry.description && <p>{entry.description}</p>}
          {(entry.uri || entry.uriTemplate) && (
            <code className="upstream-catalog-uri">{entry.uri ?? entry.uriTemplate}</code>
          )}
          {entry.mimeType && <span className="upstream-catalog-mime">{entry.mimeType}</span>}
          {Boolean(entry.arguments?.length) && (
            <div className="upstream-prompt-arguments">
              <span>{t('mcpTest.promptArguments')}</span>
              <ul>
                {entry.arguments?.map((argument) => (
                  <li key={argument.name}>
                    <code>{argument.name}</code>
                    <Tag>{t(argument.required ? 'mcpTest.required' : 'mcpTest.optional')}</Tag>
                    {argument.description && <span>{argument.description}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function UpstreamTestDetails({
  result,
  showDuration = true,
}: {
  result: UpstreamTestResult;
  showDuration?: boolean;
}) {
  const { t } = useI18n();
  const catalogs = [
    { key: 'tools', label: 'mcpTest.toolsList' as const, entries: result.tools, count: result.tools_count },
    {
      key: 'resources',
      label: 'mcpTest.resourcesList' as const,
      entries: result.resources,
      count: result.resources?.length,
    },
    { key: 'prompts', label: 'mcpTest.promptsList' as const, entries: result.prompts, count: result.prompts?.length },
    ...(result.resource_templates?.length || result.stage === 'resource_templates'
      ? [
          {
            key: 'resource_templates',
            label: 'mcpTest.resourceTemplatesList' as const,
            entries: result.resource_templates,
            count: result.resource_templates?.length,
          },
        ]
      : []),
  ];
  return (
    <div className="upstream-test-details">
      <div className="upstream-test-result" role="status">
        {!result.ok && <span>{t(upstreamTestMessages[result.reason], { status: result.http_status ?? '—' })}</span>}
        {result.server && (
          <span>{t('mcpTest.server', { name: result.server.name, version: result.server.version })}</span>
        )}
        {showDuration && <span>{t('mcpTest.duration', { duration: result.duration_ms })}</span>}
      </div>
      {(result.ok || result.server) && (
        <Collapse
          className="upstream-catalogs"
          size="small"
          items={catalogs.map((catalog) => ({
            key: catalog.key,
            label: t(catalog.label, {
              count: catalog.count ?? t(result.ok ? 'mcpTest.notProvided' : 'mcpTest.notRead'),
            }),
            children: (
              <CatalogList
                entries={catalog.entries}
                unread={!result.ok || (catalog.key === 'tools' && result.tools_count !== null)}
              />
            ),
          }))}
        />
      )}
    </div>
  );
}
