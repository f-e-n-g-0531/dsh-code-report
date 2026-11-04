/** Stream exact JSON.stringify bytes for plain captured snapshots, avoiding a giant string. */
export function* snapshotJsonChunks(value, ancestors = new Set()) {
  if (typeof value === 'string') {
    yield String.fromCharCode(34);
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 16384, value.length);
      if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield String.fromCharCode(34); return;
  }
  if (value === null || typeof value !== 'object') { yield JSON.stringify(value) ?? 'null'; return; }
  if (ancestors.has(value)) throw new TypeError('循环快照不可序列化');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('快照只允许普通 JSON 对象');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield '[';
      for (let i = 0; i < value.length; i++) { if (i) yield ','; yield* snapshotJsonChunks(value[i], ancestors); }
      yield ']';
    } else {
      yield '{'; let first = true;
      for (const key of Object.keys(value)) {
        const item = value[key];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        if (!first) yield ','; first = false;
        yield JSON.stringify(key); yield ':'; yield* snapshotJsonChunks(item, ancestors);
      }
      yield '}';
    }
  } finally { ancestors.delete(value); }
}
export function snapshotJsonBytes(value) { let bytes = 0; for (const chunk of snapshotJsonChunks(value)) bytes += Buffer.byteLength(chunk); return bytes; }
