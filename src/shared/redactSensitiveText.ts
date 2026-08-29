const patterns: Array<[RegExp, string]> = [
  [/("?(?:password|token)"?\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[redacted]$2"],
  [/("?(?:password|token)"?\s*[:=]\s*)[^\s,;"'}]+/gi, "$1[redacted]"],
  [/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]"],
];

export function redactSensitiveText(input: string): string {
  return patterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}
