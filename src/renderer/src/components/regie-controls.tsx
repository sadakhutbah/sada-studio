export const inputCls =
  "min-h-9 rounded-[7px] border border-[#b9ae94] bg-white px-2.5 py-1.5 text-[0.9rem] text-ink placeholder:text-[#6f7a73] focus:border-deep disabled:bg-paper-2 disabled:text-muted";
export const smallBtn = "min-h-8 px-2.5 py-1 text-[0.84rem]";

export function EyeBtn({
  visible,
  label,
  disabled,
  onClick,
}: {
  visible: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={visible}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border transition-colors ${
        visible
          ? "border-leaf bg-leaf/20 text-leaf"
          : "border-[#b9ae94] bg-white text-muted hover:text-ink"
      } disabled:opacity-50`}
    >
      {visible ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
      )}
    </button>
  );
}
