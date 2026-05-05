import { useEffect, useState } from "react";

interface SteamAvatarProps {
  avatarUrl?: string;
  label?: string;
  className?: string;
}

export function SteamAvatar({ avatarUrl, label, className = "faceit-avatar" }: SteamAvatarProps) {
  const [failed, setFailed] = useState(false);
  const fallback = "?";

  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);

  if (avatarUrl && !failed) {
    return (
      <div className={`${className} ${className}--image`}>
        <img alt={label ? `${label} Steam 头像` : "Steam 头像"} src={avatarUrl} onError={() => setFailed(true)} />
      </div>
    );
  }

  return <div className={`${className} ${className}--fallback`}>{fallback}</div>;
}
