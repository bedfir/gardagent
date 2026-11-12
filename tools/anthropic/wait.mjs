export async function waitUntil(read, ready, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw new Error("Accounting state was not reached before the deadline");
}
