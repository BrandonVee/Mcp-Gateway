import { LoadingOutlined } from '@ant-design/icons';
import { Flex, Typography } from 'antd';
import { BrandMark } from '@/web/components/BrandMark';
import { useI18n } from '@/web/i18n';

export function BootScreen() {
  const { t } = useI18n();
  return (
    <main className="boot-screen">
      <BrandMark className="boot-mark" size={66} />
      <Flex vertical align="center" gap={8}>
        <Typography.Text strong>{t('app.boot.title')}</Typography.Text>
        <Typography.Text type="secondary" className="mono-label">
          <LoadingOutlined spin /> {t('app.boot.initializingDetail')}
        </Typography.Text>
      </Flex>
    </main>
  );
}
