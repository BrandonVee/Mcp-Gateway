import { ReloadOutlined } from '@ant-design/icons';
import { Button, Card, Col, Result, Row, Skeleton } from 'antd';
import { useI18n } from '@/web/i18n';

export function PageSkeleton() {
  const { t } = useI18n();
  return (
    <div className="page-stack page-enter" aria-label={t('app.loading.label')}>
      <Row gutter={[16, 16]}>
        {Array.from({ length: 4 }, (_, index) => (
          <Col xs={24} sm={12} xl={6} key={index}>
            <Card className="metric-card skeleton-card">
              <Skeleton active paragraph={{ rows: 1 }} title={{ width: '42%' }} />
            </Card>
          </Col>
        ))}
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card className="dashboard-card skeleton-panel">
            <Skeleton active paragraph={{ rows: 6 }} />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card className="dashboard-card skeleton-panel">
            <Skeleton active avatar paragraph={{ rows: 5 }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

export function DataLoadError({
  message,
  loading,
  onRetry,
}: {
  message: string;
  loading: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <Card className="data-load-error" bordered={false}>
      <Result
        status="warning"
        title={t('app.loading.errorTitle')}
        subTitle={message}
        extra={
          <Button type="primary" icon={<ReloadOutlined />} loading={loading} onClick={onRetry}>
            {t('app.loading.retry')}
          </Button>
        }
      />
    </Card>
  );
}
