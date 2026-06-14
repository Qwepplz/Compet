const BADGE_PATH =
  "M5 5h4l3-3 3 3h4v4l3 3-3 3v4h-4l-3 3-3-3H5v-4l-3-3 3-3zm6.098 11.737-5.414-5.684 5.414 1.894 7.218-5.684z";

interface VerificationBadgeProps {
  variant: "gold" | "white";
  title: string;
}

export function VerificationBadge({ variant, title }: VerificationBadgeProps) {
  const gradientId = `verif-gold-${title}`;
  return (
    <svg
      className="faceit-verif-badge"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {variant === "gold" ? (
        <defs>
          <linearGradient id={gradientId} x1="12" x2="12" y1="2" y2="22" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FFFFB4" />
            <stop offset="1" stopColor="#F4982F" />
          </linearGradient>
        </defs>
      ) : null}
      <path fill={variant === "gold" ? `url(#${gradientId})` : "#fff"} fillRule="evenodd" d={BADGE_PATH} clipRule="evenodd" />
    </svg>
  );
}
