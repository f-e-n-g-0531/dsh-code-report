import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const normalize = text => text.replace(/\r\n/g, '\n').trim();
const sections = text => new Map(text.split(/^## /m).slice(1).map(section => {
  const end = section.indexOf('\n');
  return [section.slice(0, end).trim(), section.slice(end + 1)];
}));
const lock = JSON.parse(await read('package-lock.json'));
const production = Object.entries(lock.packages).filter(([path, pkg]) => path && !pkg.dev);
const notices = sections(await read('THIRD_PARTY_NOTICES.md'));

test('third-party notices cover every locked production dependency', () => {
  assert.ok(production.length > 0);
  for (const [path, pkg] of production) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    assert.ok(notices.has(name), name + '@' + pkg.version + ' needs a notice');
    assert.equal(pkg.license, 'MIT', name + ' license changed; review original terms');
  }
});

test('notices retain the complete installed license text where supplied', async () => {
  for (const [path] of production) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    // This published version supplies only MIT metadata; its limitation is tested below.
    if (name === '@nodable/entities') continue;
    const license = await read(path + '/LICENSE');
    assert.ok(normalize(notices.get(name) ?? '').includes(normalize(license)), name + ' original license must be retained');
  }
});

test('entities notice reflects upstream metadata without inventing copyright or relicensing', async () => {
  const path = 'node_modules/@nodable/entities';
  const pkg = JSON.parse(await read(path + '/package.json'));
  assert.equal(lock.packages[path].version, '3.1.0', 'recheck the upstream notice when updating entities');
  assert.equal(pkg.version, '3.1.0');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.author, 'Amit Gupta (https://solothought.com)');
  assert.match(await read(path + '/README.md'), /## License\s+MIT\s*$/);
  const notice = notices.get('@nodable/entities') ?? '';
  for (const text of ['3.1.0', 'MIT', pkg.author, pkg.repository.url, 'tarball omits the LICENSE file', 'not a relicense', 'ac48e7ea591da372be023a481875c747535812b3']) {
    assert.ok(notice.includes(text), text);
  }
  assert.match(notice, /Copyright \(c\) 2026 Nodable/);
  for (const text of ['Permission is hereby granted, free of charge', 'The above copyright notice', 'THE SOFTWARE IS PROVIDED "AS IS"']) assert.ok(notice.includes(text));
});
