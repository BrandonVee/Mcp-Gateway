export function formatTime(timestamp?: number) {
  if (!timestamp) return "等待同步";

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

export function initials(value: string) {
  return value.slice(0, 2).toUpperCase();
}
