import { ReloadOutlined } from "@ant-design/icons";
import { Button, Card, Col, Result, Row, Skeleton } from "antd";

export function PageSkeleton() {
  return (
    <div className="page-stack page-enter" aria-label="正在加载控制平面数据">
      <Row gutter={[16, 16]}>
        {Array.from({ length: 4 }, (_, index) => (
          <Col xs={24} sm={12} xl={6} key={index}>
            <Card className="metric-card skeleton-card">
              <Skeleton
                active
                paragraph={{ rows: 1 }}
                title={{ width: "42%" }}
              />
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
  return (
    <Card className="data-load-error" bordered={false}>
      <Result
        status="warning"
        title="控制平面数据加载失败"
        subTitle={message}
        extra={
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={onRetry}
          >
            重新加载
          </Button>
        }
      />
    </Card>
  );
}
