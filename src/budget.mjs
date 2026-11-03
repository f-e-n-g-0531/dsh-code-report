/** Optional request-wide budgets. No default byte cap or deadline; cancellation always applies. */
export function createCollectionBudget({maxBytes, signal, now = () => performance.now(), timeoutMs} = {}) {
  if ((maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) ||
      (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))) throw new Error('无效采集预算');
  const deadline = timeoutMs === undefined ? undefined : now() + timeoutMs;
  let bytes = 0;
  function check() {
    signal?.throwIfAborted();
    if (deadline !== undefined && now() >= deadline) throw new Error('采集总时间超过调用者预算，未生成不完整报告');
  }
  function assertBytes(size) {
    check();
    if (maxBytes !== undefined && size > maxBytes) throw new Error('报告证据超过调用者指定的 ' + maxBytes + ' bytes 上限，未静默截断');
  }
  return {
    signal, maxBytes, check,
    checkpoint(snapshot) {
      check();
      // Avoid serializing all previous source files after every append when no byte budget exists.
      if (maxBytes === undefined) return;
      const size = Buffer.byteLength(JSON.stringify(snapshot));
      assertBytes(size); bytes = size; return size;
    },
    assertAdditional(size) { assertBytes(bytes + size); },
    commandTimeout() { check(); return deadline === undefined ? undefined : Math.max(1, Math.ceil(deadline - now())); },
  };
}
