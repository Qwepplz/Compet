import { useEffect, useState } from "react";

// Steam-style gray "?" placeholder, inlined so misses never hit the network.
const PLACEHOLDER_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="184" height="184" viewBox="0 0 184 184">' +
      '<rect width="184" height="184" fill="#3a3f44"/>' +
      '<text x="92" y="92" fill="#8f98a0" font-family="Arial, sans-serif" font-size="110" ' +
      'font-weight="bold" text-anchor="middle" dominant-baseline="central">?</text>' +
      "</svg>",
  );

interface SteamAvatarProps {
  avatarUrl?: string;
  label?: string;
  className?: string;
}

export function SteamAvatar({ avatarUrl, label, className = "faceit-avatar" }: SteamAvatarProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);

  const src = avatarUrl && !failed ? avatarUrl : PLACEHOLDER_AVATAR;
  return (
    <div className={`${className} ${className}--image`}>
      <img alt={label ? `${label} Steam 头像` : "Steam 头像"} src={src} onError={() => setFailed(true)} />
    </div>
  );
}
