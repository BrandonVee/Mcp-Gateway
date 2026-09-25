import type { ReactNode } from "react";
import { Flex, Space, Typography } from "antd";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n";

interface PageToolbarProps {
  eyebrow: string;
  title: MessageKey;
  description: MessageKey;
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
  const { t } = useI18n();
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
          <Typography.Title level={3}>{t(title)}</Typography.Title>
          <Typography.Paragraph type="secondary">
            {t(description)}
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
