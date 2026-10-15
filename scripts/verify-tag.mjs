import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const tag=process.env.GITHUB_REF_NAME;
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
assert.match(tag||'',/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(tag,'v'+pkg.version);console.log('Verified tag',tag);
