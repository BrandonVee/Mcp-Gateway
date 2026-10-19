import type { ReactNode } from 'react';
import { Flex } from 'antd';

interface PageToolbarProps {
  primaryAction?: ReactNode;
  filters?: ReactNode;
}

export function PageToolbar({ primaryAction, filters }: PageToolbarProps) {
  return (
    <section className="page-toolbar">
      {filters && (
        <Flex className="page-toolbar-filters" align="center" gap={12} wrap>
          {filters}
        </Flex>
      )}
      {primaryAction && <div className="page-toolbar-actions">{primaryAction}</div>}
    </section>
  );
}
