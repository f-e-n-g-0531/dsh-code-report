const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const gb18030 = new TextDecoder('gb18030', {fatal: true, ignoreBOM: true});

function inputBytes(value) {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('文本解码输入必须是 ArrayBuffer 或 ArrayBufferView');
}

function inputLabel(label) {
  return typeof label === 'string' && label ? label : '输入文本';
}

function rejectBinary(bytes, label) {
  if (bytes.includes(0)) {
    throw Object.assign(new Error(inputLabel(label) + ' 含 NUL 字节，按二进制拒绝；不自动解码 UTF-16'), {code: 'code-report/binary-input'});
  }
}

function decodeUnit(bytes, label) {
  try {
    return {text: utf8.decode(bytes), encoding: 'utf-8'};
  } catch {
    try {
      return {text: gb18030.decode(bytes), encoding: 'gb18030'};
    } catch {
      throw Object.assign(new Error(inputLabel(label) + ' 既不是有效 UTF-8，也不是有效 GB18030（兼容 GBK）；拒绝替换非法字节'), {code: 'code-report/text-encoding'});
    }
  }
}

/**
 * Automatic, UTF-8-first heuristic for one complete file. Fatal decoders never
 * manufacture U+FFFD; a U+FFFD already encoded in valid input remains unchanged.
 * This cannot infer author intent, repair mojibake, or identify other encodings.
 */
export function decodeSourceBytes(value, {label} = {}) {
  const bytes = inputBytes(value);
  rejectBinary(bytes, label);
  return decodeUnit(bytes, label);
}

/**
 * Diff metadata may be UTF-8 while individual file bodies use GBK/GB18030.
 * Split at the ORIGINAL byte LF boundaries before decoding. Include each LF in
 * its unit so CRLF, lone CR, BOM and trailing-newline state remain unchanged.
 * Every line is UTF-8-first, not every whole diff; mixed encodings inside ONE
 * line are not supported or reliably detectable. ASCII is encoding-neutral.
 */
export function decodeDiffBytes(value, {label} = {}) {
  const bytes = inputBytes(value);
  rejectBinary(bytes, label);
  const lines = [];
  let start = 0, utf8NonAscii = false, legacy = false;
  const append = end => {
    const line = bytes.subarray(start, end);
    const decoded = decodeUnit(line, label);
    lines.push(decoded.text);
    if (decoded.encoding === 'gb18030') legacy = true;
    else if (line.some(byte => byte >= 0x80)) utf8NonAscii = true;
    start = end;
  };
  for (let offset = 0; offset < bytes.length; offset++) {
    if (bytes[offset] === 0x0a) append(offset + 1);
  }
  if (start < bytes.length) append(bytes.length);
  return {text: lines.join(''), encoding: legacy ? utf8NonAscii ? 'utf-8+gb18030' : 'gb18030' : 'utf-8'};
}
