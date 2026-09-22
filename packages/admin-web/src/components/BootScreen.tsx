import { LoadingOutlined, RadarChartOutlined } from "@ant-design/icons";
import { Flex, Typography } from "antd";

export function BootScreen() {
  return (
    <main className="boot-screen">
      <div className="boot-mark">
        <RadarChartOutlined />
      </div>
      <Flex vertical align="center" gap={8}>
        <Typography.Text strong>正在启动控制平面</Typography.Text>
        <Typography.Text type="secondary" className="mono-label">
          <LoadingOutlined spin /> INITIALIZING CONTROL PLANE
        </Typography.Text>
      </Flex>
    </main>
  );
}
