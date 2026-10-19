import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { FileTextOutlined } from '@ant-design/icons';
import { useI18n } from '@/web/i18n';
import '@/web/components/service-description.css';

export function ServiceDescription({ description, compact = false }: { description?: string; compact?: boolean }) {
  const { t } = useI18n();
  const text = description?.trim() ?? '';
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => setExpanded(false), [text]);
  useLayoutEffect(() => {
    const element = paragraph.current;
    if (!element || expanded) return;
    const measure = () => setTruncated(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [text, expanded, compact]);

  if (compact && !text) return null;

  return (
    <section
      className={`service-description${text ? '' : ' service-description-empty'}${compact ? ' service-description-compact' : ''}`}
      aria-label={t('connections.description')}
    >
      {!compact && (
        <div className="service-description-heading">
          <FileTextOutlined />
          <span>{t('connections.description')}</span>
        </div>
      )}
      <p ref={paragraph} className={expanded ? 'is-expanded' : 'is-collapsed'}>
        {text || t('connections.noDescription')}
      </p>
      {truncated && (
        <Button type="link" size="small" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          {t(expanded ? 'connections.collapseDescription' : 'connections.expandDescription')}
        </Button>
      )}
    </section>
  );
}
