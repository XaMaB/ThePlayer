/** Fail a stalled browser RPC too: Playwright evaluate/close has no action timeout. */
export function caseDeadline(label, timeoutMs = 120000) {
  let phase = 'create page';
  const timer = setTimeout(() => {
    console.error(`${label}: exceeded ${timeoutMs} ms during ${phase}`);
    process.exit(1);
  }, timeoutMs);
  timer.unref();
  return {
    phase(value) {
      phase = value;
    },
    finish() {
      clearTimeout(timer);
    },
  };
}
