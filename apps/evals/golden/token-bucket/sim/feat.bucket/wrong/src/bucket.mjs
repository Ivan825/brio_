export function createBucket({ capacity }) {
  let tokens = capacity;
  return {
    allow() {
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
