import type { ReactNode } from "react";
import { Flex, Space, Typography } from "antd";

interface PageToolbarProps {
  eyebrow: string;
  title: string;
  description: string;
  primaryAction?: ReactNode;
  filters?: ReactNode;
}

export function PageToolbar({
  eyebrow,
  title,
  description,
  primaryAction,
  filters,
}: PageToolbarProps) {
  return (
    <section className="page-toolbar">
      <Flex
        className="page-toolbar-heading"
        align="center"
        justify="space-between"
        gap={24}
        wrap
      >
        <div>
          <Typography.Text className="section-eyebrow">
            {eyebrow}
          </Typography.Text>
          <Typography.Title level={3}>{title}</Typography.Title>
          <Typography.Paragraph type="secondary">
            {description}
          </Typography.Paragraph>
        </div>
        {primaryAction}
      </Flex>
      {filters && (
        <Space className="page-toolbar-filters" size={10} wrap>
          {filters}
        </Space>
      )}
    </section>
  );
}
