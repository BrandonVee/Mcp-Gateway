import { UsageMonitoring } from '@/web/features/monitoring/UsageMonitoring';
import '@/web/features/monitoring/monitoring.css';

export function MonitoringPage() {
  return (
    <div className="page-stack page-enter monitor-page">
      <UsageMonitoring />
    </div>
  );
}
