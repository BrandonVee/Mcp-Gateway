export function BrandMark({ className = '', size = 32 }: { className?: string; size?: number }) {
  return (
    <img
      className={`brand-mark ${className}`}
      src="/brand-mark.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
