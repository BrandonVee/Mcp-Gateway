import { useState } from 'react';
import { UsageMonitoring } from '@/web/features/monitoring/UsageMonitoring';
import type { UsageCollectionStatus } from '@/web/types';
import '@/web/features/monitoring/monitoring.css';

export function MonitoringPage() {
  const [collectionStatus, setCollectionStatus] = useState<UsageCollectionStatus | null>(null);
  return (
    <div className="page-stack page-enter monitor-page">
      <UsageMonitoring mode="overview" onCollectionStatus={setCollectionStatus} />
      <UsageMonitoring mode="logs" collectionStatus={collectionStatus} />
    </div>
  );
}
