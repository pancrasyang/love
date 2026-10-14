import {photoHandler} from '../server/photos.mjs';
export {sourcePath} from '../server/photos.mjs';
export default function handler(req,res){const url=new URL(req.url,'https://local.invalid');url.searchParams.set('source','legacy');return photoHandler({method:req.method,headers:req.headers,url:url.pathname+'?'+url.searchParams},res);}
