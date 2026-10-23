export function createBucket({ capacity, refillPerSec, now }) {
  let tokens = capacity;
  let last = now();
  return {
    allow() {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
