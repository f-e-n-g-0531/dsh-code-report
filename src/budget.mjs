const MIB = 1024 * 1024;
export const COLLECTION_TIMEOUT_MS = 240000;

/** A request-wide budget: commands never reset its monotonic deadline. */
export function createCollectionBudget({allowBatches = false, signal, now = () => performance.now(), timeoutMs = COLLECTION_TIMEOUT_MS} = {}) {
  const maxBytes = allowBatches === true ? 8 * MIB : MIB;
  const deadline = now() + timeoutMs;
  let bytes = 0;
  function check() {
    signal?.throwIfAborted();
    if (now() >= deadline) throw new Error('采集总时间超过安全预算，未生成不完整报告');
  }
  function assertBytes(size) {
    check();
    if (size > maxBytes) throw new Error('报告证据超过 ' + (maxBytes / MIB) + ' MiB；请分批比较，未静默截断');
  }
  return {
    signal, maxBytes, check,
    checkpoint(snapshot) {
      const size = Buffer.byteLength(JSON.stringify(snapshot));
      assertBytes(size);
      bytes = size;
      return size;
    },
    assertAdditional(size) { assertBytes(bytes + size); },
    commandTimeout() { check(); return Math.max(1, Math.min(60000, Math.ceil(deadline - now()))); },
  };
}
