import { sha256 } from './auth.js';
import { one } from './db.js';

// Serverless instances share nothing, so counters live in the database. It is a
// fixed window: good enough to stop abuse, and it never stores an address.
export const LIMITS = Object.freeze({
  // A sign-in makes two requests, so this allows about 15 sign-ins per address.
  login: { max: 30, windowSeconds: 300 },
  write: { max: 120, windowSeconds: 60 },
  job: { max: 12, windowSeconds: 60 }
});

export function createRateLimiter({ db, now = () => new Date() }) {
  return {
    async hit(kind, identity) {
      const { max, windowSeconds } = LIMITS[kind];
      const current = now();
      const cutoff = new Date(current.getTime() - windowSeconds * 1000);
      const row = await db.as('hub_auth', null, async tx => one(await tx.query(
        `insert into hub.rate_limits (bucket, window_started_at, hits) values ($1, $2, 1)
         on conflict (bucket) do update set
           hits = case when hub.rate_limits.window_started_at <= $3 then 1 else hub.rate_limits.hits + 1 end,
           window_started_at = case when hub.rate_limits.window_started_at <= $3 then excluded.window_started_at else hub.rate_limits.window_started_at end
         returning hits, window_started_at`,
        [sha256(`${kind}:${identity}`), current, cutoff])));
      const allowed = row.hits <= max;
      const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((new Date(row.window_started_at).getTime() + windowSeconds * 1000 - current.getTime()) / 1000));
      return { allowed, retryAfter };
    }
  };
}
