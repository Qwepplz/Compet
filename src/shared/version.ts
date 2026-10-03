const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isSemver(value: string): boolean {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = pattern.exec(value);
  return !!match && match[0] === value && !(match[4]?.split(".").some((part) => /^0\d+$/.test(part)));
}

function compareIdentifier(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : Math.sign(a.length - b.length);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemver(a: string, b: string): number {
  if (!isSemver(a) || !isSemver(b)) throw Object.assign(new Error("Invalid version"), { code: "update_version_invalid" });
  const left = pattern.exec(a)!;
  const right = pattern.exec(b)!;
  for (let i = 1; i <= 3; i++) {
    const order = compareIdentifier(left[i]!, right[i]!);
    if (order) return order;
  }
  if (left[4] === right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  const l = left[4].split("."), r = right[4].split(".");
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    const x = l[i], y = r[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    return xn !== yn ? (xn ? -1 : 1) : compareIdentifier(x, y);
  }
  return 0;
}
