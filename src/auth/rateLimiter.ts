export class InMemoryLoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 60_000,
  ) {}

  check(username: string, ip: string): void {
    const key = `${username.toLowerCase()}|${ip}`;
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 0, resetAt: now + this.windowMs });
      return;
    }
    if (entry.count >= this.maxAttempts) throw new Error("too many login attempts");
  }

  recordFailure(username: string, ip: string): void {
    const key = `${username.toLowerCase()}|${ip}`;
    const entry = this.attempts.get(key) ?? { count: 0, resetAt: Date.now() + this.windowMs };
    this.attempts.set(key, { ...entry, count: entry.count + 1 });
  }

  clear(username: string, ip: string): void {
    this.attempts.delete(`${username.toLowerCase()}|${ip}`);
  }
}
