import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const base=JSON.parse(readFileSync('tests/baseline.json'));
assert.equal(createHash('sha256').update(readFileSync('letter.html')).digest('hex'),base.letter_sha256,'letter.html changed');
for (const file of ['index.html','letter.html']) {
 const html=readFileSync(file,'utf8');
 assert(html.trim().endsWith('</html>'),file+' truncated');
 for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new Function(match[1]);
}
function check(dir){for(const e of readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='node_modules')continue; const f=dir+'/'+e.name; if(e.isDirectory())check(f);else if(/\.(m?js)$/.test(f))execFileSync(process.execPath,['--check',f]);}}
check('.');
execFileSync(process.execPath,['scripts/build-worker.mjs','--check'],{stdio:'inherit'});
console.log('JS syntax, HTML endings, and original letter SHA-256 passed');
