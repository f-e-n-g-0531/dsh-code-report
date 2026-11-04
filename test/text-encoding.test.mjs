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

test('source without BOM and all diffs reject NUL before fallback rather than guessing UTF-16', () => {
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

const utf16 = (text, bigEndian = false) => {const value=Buffer.from(text,'utf16le');return bigEndian ? value.swap16() : value;};

test('source recognizes UTF-16 LE and BE only with BOM and preserves BOM CRLF and astral text', () => {
 const text='\ufeff// copyright © 中文🙂\r\nline\r';
 for(const bigEndian of [false,true]){
  const bytes=utf16(text,bigEndian),original=Buffer.from(bytes);
  assert.deepEqual(decodeSourceBytes(bytes),{text,encoding:bigEndian?'utf-16be-bom':'utf-16le-bom'});
  assert.deepEqual(bytes,original);
 }
 for(const bigEndian of [false,true])assert.equal(decodeSourceBytes(utf16('\ufeff',bigEndian)).text,'\ufeff');
});

test('BOM UTF-16 source rejects odd lengths and unpaired surrogates without legacy fallback', () => {
 for(const bigEndian of [false,true])for(const value of ['\ufeff\ud800','\ufeff\udc00','\ufeff\ud800A','\ufeffA\udc00']){
  assert.throws(()=>decodeSourceBytes(utf16(value,bigEndian),{label:'broken.rc'}),error=>error.code==='code-report/text-encoding'&&/broken.rc.*UTF-16/.test(error.message));
 }
 for(const hex of ['fffe41','feff00','fffe00d8ff','feffd800ff'])assert.throws(()=>decodeSourceBytes(Buffer.from(hex,'hex')),{code:'code-report/text-encoding'});
});

test('BOM UTF-16 rejects decoded NUL but not ordinary zero bytes used by ASCII code units', () => {
 for(const bigEndian of [false,true]){
  assert.equal(decodeSourceBytes(utf16('\ufeffASCII\r\n',bigEndian)).text,'\ufeffASCII\r\n');
  assert.throws(()=>decodeSourceBytes(utf16('\ufeffA\0B',bigEndian),{label:'binary.rc'}),error=>error.code==='code-report/binary-input'&&/binary.rc.*NUL/.test(error.message));
 }
 for(const bytes of [utf16('AB'),utf16('AB',true)])assert.throws(()=>decodeSourceBytes(bytes),{code:'code-report/binary-input'});
});

test('new BOM source paths respect exact views and do not mutate raw bytes', () => {
 for(const bigEndian of [false,true]){
  const raw=utf16('\ufeffA🙂',bigEndian),storage=Buffer.concat([Buffer.from([255]),raw,Buffer.from([0,255])]),original=Buffer.from(storage);
  for(const value of [storage.subarray(1,1+raw.length),new DataView(storage.buffer,storage.byteOffset+1,raw.length),new Uint8Array(storage.buffer,storage.byteOffset+1,raw.length),Uint8Array.from(raw).buffer]){
   assert.equal(decodeSourceBytes(value).text,'\ufeffA🙂');
  }
  assert.deepEqual(storage,original);
 }
});

test('copyright-only source fallback maps exactly ASCII plus A9 and surfaces ambiguity', () => {
 for(const bytes of [Buffer.from([0xa9]),concat('// ',Buffer.from([0xa9]),' Valve\r\n')]){
  const original=Buffer.from(bytes),decoded=decodeSourceBytes(bytes,{label:'any-name.custom'});
  assert.equal(decoded.encoding,'windows-1252-copyright');assert.equal(decoded.text,bytes.toString('latin1'));assert.match(decoded.encodingWarning,/歧义/);assert.match(decoded.encodingWarning,/不代表支持通用 Windows-1252/);assert.ok(!decoded.text.includes('\ufffd'));assert.deepEqual(bytes,original);
 }
 assert.deepEqual(decodeSourceBytes(utf8('©')),{text:'©',encoding:'utf-8'});
 assert.equal(decodeSourceBytes(Buffer.from('a9a9','hex')).encoding,'gb18030');
});

test('copyright exception does not accept other Western bytes or conceal truncated sequences', () => {
 for(const hex of ['a9ff','a981ff','a980ff','a996ff','e9','93','81','c2','e282ff','f09f92']){
  assert.throws(()=>decodeSourceBytes(Buffer.from(hex,'hex'),{label:'bad.h'}),error=>error.code==='code-report/text-encoding'&&/bad.h/.test(error.message));
 }
 // These byte pairs are already valid GB18030, even if another encoding could interpret them differently.
 for(const hex of ['a981','a980','a996','e282'])assert.equal(decodeSourceBytes(Buffer.from(hex,'hex')).encoding,'gb18030');
 assert.throws(()=>decodeSourceBytes(Buffer.from([0xa9,0])),{code:'code-report/binary-input'});
});

test('diff policy remains strict and does not inherit BOM UTF-16 or copyright source exceptions', () => {
 for(const bigEndian of [false,true])assert.throws(()=>decodeDiffBytes(utf16('\ufeff+ASCII\r\n',bigEndian)),{code:'code-report/binary-input'});
 for(const value of [Buffer.from([0xa9]),concat('+',Buffer.from([0xa9]),'\n')])assert.throws(()=>decodeDiffBytes(value),{code:'code-report/text-encoding'});
});

test('a broken multibyte sequence cannot borrow bytes from the next original LF line', () => {
  const bytes = Buffer.from([0x2b, 0x81, 0x0a, 0x40, 0x0a]);
  assert.throws(() => decodeDiffBytes(bytes, {label: 'diff.cpp'}), /diff.cpp.*UTF-8.*GB18030/);
});
