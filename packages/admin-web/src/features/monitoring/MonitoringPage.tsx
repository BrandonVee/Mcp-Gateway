import { UsageMonitoring } from './UsageMonitoring';
import './monitoring.css';

export function MonitoringPage() {
  return (
    <div className="page-stack page-enter monitor-page">
      <UsageMonitoring mode="overview" />
      <UsageMonitoring mode="logs" />
    </div>
  );
}
