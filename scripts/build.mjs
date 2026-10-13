import {mkdirSync,rmSync,copyFileSync,cpSync} from 'node:fs';
rmSync('dist',{recursive:true,force:true});mkdirSync('dist');
for(const file of ['index.html','letter.html'])copyFileSync(file,'dist/'+file);
cpSync('assets','dist/assets',{recursive:true});
console.log('Static site built; server functions remain in api/.');
