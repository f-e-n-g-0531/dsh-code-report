import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeSourceBytes, decodeDiffBytes} from '../src/text-encoding.mjs';

const gbkChinese = Buffer.from('d6d0cec4', 'hex');
const gb18030Smile = Buffer.from('95308532', 'hex');
const utf8 = text => Buffer.from(text, 'utf8');
const concat = (...parts) => Buffer.concat(parts.map(part => typeof part === 'string' ? utf8(part) : part));

test('source prefers strict UTF-8 including valid ambiguous bytes and empty ASCII input', () => {
  for (const text of ['', 'ascii\r\n', '中文🙂', '©', 'already mojibake ä¸­æ–‡']) {
    assert.deepEqual(decodeSourceBytes(utf8(text)), {text, encoding: 'utf-8'});
  }
  // C2 A9 also has a GB18030 interpretation: the UTF-8 interpretation wins.
  assert.deepEqual(decodeSourceBytes(Buffer.from('c2a9', 'hex')), {text: '©', encoding: 'utf-8'});
});

test('fixed GBK Chinese and GB18030 four-byte supplementary character decode without replacement', () => {
  assert.deepEqual(decodeSourceBytes(gbkChinese), {text: '中文', encoding: 'gb18030'});
  assert.deepEqual(decodeSourceBytes(gb18030Smile), {text: '🙂', encoding: 'gb18030'});
  assert.deepEqual(decodeSourceBytes(concat('// ', gbkChinese, '\r\n', gb18030Smile)), {text: '// 中文\r\n🙂', encoding: 'gb18030'});
});

test('ArrayBuffer and exact byte views respect offsets and lengths without reading adjacent data', () => {
  const storage = Uint8Array.from([0, ...gbkChinese, 0xff, 0]);
  const view = new Uint8Array(storage.buffer, 1, gbkChinese.length);
  const dataView = new DataView(storage.buffer, 1, gbkChinese.length);
  for (const value of [view, dataView, Buffer.from(storage.buffer, 1, gbkChinese.length)]) {
    assert.deepEqual(decodeSourceBytes(value), {text: '中文', encoding: 'gb18030'});
    assert.deepEqual(decodeDiffBytes(value), {text: '中文', encoding: 'gb18030'});
  }
  const buffer = Uint8Array.from(gbkChinese).buffer;
  assert.deepEqual(decodeSourceBytes(buffer), {text: '中文', encoding: 'gb18030'});
  assert.deepEqual(decodeSourceBytes(new Uint16Array(buffer)), {text: '中文', encoding: 'gb18030'});
  assert.deepEqual(decodeSourceBytes(new Uint8Array(storage.buffer, 2, 0)), {text: '', encoding: 'utf-8'});
  assert.deepEqual(storage, Uint8Array.from([0, ...gbkChinese, 0xff, 0]));
  for (const invalid of [undefined, null, 'not bytes', [0x41], {buffer}]) {
    assert.throws(() => decodeSourceBytes(invalid), TypeError);
    assert.throws(() => decodeDiffBytes(invalid), TypeError);
  }
});

test('source and diff reject NUL before fallback rather than interpreting UTF-16 or binary', () => {
  for (const bytes of [Buffer.from([0]), Buffer.from([0x41, 0, 0x42, 0]), concat(gbkChinese, Buffer.from([0]))]) {
    for (const decode of [decodeSourceBytes, decodeDiffBytes]) {
      assert.throws(() => decode(bytes, {label: 'sample.bin'}), error => error.code === 'code-report/binary-input' && /sample.bin.*NUL/.test(error.message));
    }
  }
});

test('malformed and incomplete data fail closed with a label and no implicit replacement', () => {
  for (const hex of ['81', '8130', '813081', 'ff', '8130ff30']) {
    const bytes = Buffer.from(hex, 'hex');
    for (const decode of [decodeSourceBytes, decodeDiffBytes]) {
      assert.throws(() => decode(bytes, {label: 'broken.cpp'}), error => error.code === 'code-report/text-encoding' && /broken.cpp/.test(error.message) && /UTF-8.*GB18030/.test(error.message));
    }
  }
  // A valid, deliberately encoded replacement character is source data, not an error substitution.
  assert.equal(decodeSourceBytes(utf8('\ufffd')).text, '\ufffd');
});

test('UTF-8 BOM is preserved in a source and at every diff line boundary', () => {
  const source = '\ufeff// 中文\r\n';
  assert.deepEqual(decodeSourceBytes(utf8(source)), {text: source, encoding: 'utf-8'});
  const diff = '\ufeffIndex: 中文.cpp\r\n\ufeff+内容\n';
  assert.deepEqual(decodeDiffBytes(utf8(diff)), {text: diff, encoding: 'utf-8'});
});

test('diff decodes UTF-8 non-ASCII paths separately from GBK body lines', () => {
  const bytes = concat('diff --git a/中文.cpp b/中文.cpp\r\n--- a/中文.cpp\r\n+++ b/中文.cpp\r\n@@ -1 +1 @@\r\n-', gbkChinese, '\r\n+', gb18030Smile, '\r\n');
  const result = decodeDiffBytes(bytes);
  assert.deepEqual(result, {text: 'diff --git a/中文.cpp b/中文.cpp\r\n--- a/中文.cpp\r\n+++ b/中文.cpp\r\n@@ -1 +1 @@\r\n-中文\r\n+🙂\r\n', encoding: 'utf-8+gb18030'});
  assert.ok(!result.text.includes('\ufffd'));
});

test('diff supports two files with different body encodings without whole-buffer fallback corruption', () => {
  const bytes = concat('Index: first.cpp\n@@ -1 +1 @@\n-', gbkChinese, '\n+中文\nIndex: second.cpp\n@@ -1 +1 @@\n-🙂\n+', gb18030Smile);
  assert.deepEqual(decodeDiffBytes(bytes), {text: 'Index: first.cpp\n@@ -1 +1 @@\n-中文\n+中文\nIndex: second.cpp\n@@ -1 +1 @@\n-🙂\n+🙂', encoding: 'utf-8+gb18030'});
});

test('ASCII metadata is neutral when all non-ASCII diff lines use GBK', () => {
  const bytes = concat('Index: file.cpp\n@@ -1 +1 @@\n-', gbkChinese, '\n+', gb18030Smile, '\n');
  assert.deepEqual(decodeDiffBytes(bytes), {text: 'Index: file.cpp\n@@ -1 +1 @@\n-中文\n+🙂\n', encoding: 'gb18030'});
  assert.deepEqual(decodeDiffBytes(utf8('@@ -1 +1 @@\n-a\n+b\n')), {text: '@@ -1 +1 @@\n-a\n+b\n', encoding: 'utf-8'});
});

test('byte LF framing preserves CRLF, lone CR, empty lines and missing final newline', () => {
  for (const [tail, expected] of [['\r\n\n\r\n', '\r\n\n\r\n'], ['\r', '\r'], ['', ''], ['\n', '\n']]) {
    assert.deepEqual(decodeDiffBytes(concat('+', gbkChinese, tail)), {text: '+中文' + expected, encoding: 'gb18030'});
  }
  assert.deepEqual(decodeDiffBytes(utf8('')), {text: '', encoding: 'utf-8'});
  assert.deepEqual(decodeDiffBytes(utf8('\n\r\n')), {text: '\n\r\n', encoding: 'utf-8'});
});

test('a broken multibyte sequence cannot borrow bytes from the next original LF line', () => {
  const bytes = Buffer.from([0x2b, 0x81, 0x0a, 0x40, 0x0a]);
  assert.throws(() => decodeDiffBytes(bytes, {label: 'diff.cpp'}), /diff.cpp.*UTF-8.*GB18030/);
});
