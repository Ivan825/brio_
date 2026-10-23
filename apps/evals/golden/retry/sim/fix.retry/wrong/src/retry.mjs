export async function retry(fn, times) {
  let last;
  for (let i = 0; i <= times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
