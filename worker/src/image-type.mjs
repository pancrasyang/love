export const MAX_BYTES=10*1024*1024;
function dimensions(w,h){if(!w||!h||w>16384||h>16384||w*h>40000000)throw Error('图片尺寸超出限制');}
function jpegLength(b,v){
 let p=2,frame=false,scan=false;
 while(p<b.length){
  if(b[p++]!==255)throw Error('JPEG 标记无效');
  while(b[p]===255)p++;
  if(p>=b.length)throw Error('JPEG 不完整');
  const marker=b[p++];
  if(marker===217){if(!frame||!scan)throw Error('JPEG 缺少图像数据');return p;}
  if(marker===0||marker===216||(marker>=208&&marker<=215))throw Error('JPEG 标记无效');
  if(marker===1)continue;
  if(p+2>b.length)throw Error('JPEG 不完整');
  const n=v.getUint16(p);
  if(n<2||p+n>b.length)throw Error('JPEG 分段无效');
  if([192,193,194].includes(marker)){
   if(n<8)throw Error('JPEG 尺寸无效');
   const components=b[p+7];
   if(!components||components>4||n!==8+3*components)throw Error('JPEG 帧头无效');
   dimensions(v.getUint16(p+5),v.getUint16(p+3));frame=true;
  }
  if(marker!==218){p+=n;continue;}
  if(!frame||n<6||!b[p+2]||b[p+2]>4||n!==6+2*b[p+2])throw Error('JPEG 扫描头无效');
  p+=n;let data=false;
  // Marker bytes inside entropy data are stuffed (FF 00); restart markers
  // do not end the scan. Other markers return to the outer segment parser.
  while(p<b.length){
   if(b[p]!==255){data=true;p++;continue;}
   let q=p+1;while(b[q]===255)q++;
   if(q>=b.length)throw Error('JPEG 不完整');
   if(b[q]===0){data=true;p=q+1;continue;}
   if(b[q]>=208&&b[q]<=215){p=q+1;continue;}
   break;
  }
  if(!data)throw Error('JPEG 缺少图像数据');scan=true;
 }
 throw Error('JPEG 缺少结束标记');
}
// Validate signatures, container boundaries and dimensions; never trust a filename/MIME alone.
export function inspectImage(buffer,declared){
 const b=new Uint8Array(buffer),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
 if(!b.length||b.length>MAX_BYTES)throw Error('图片不能超过 10MB');
 let type,ext,byteLength=b.length;const ascii=(i,n)=>String.fromCharCode(...b.slice(i,i+n));
 if(b.length>=45&&ascii(1,3)==='PNG'&&b[0]===137&&b[4]===13&&b[5]===10&&b[6]===26&&b[7]===10){
  if(v.getUint32(8)!==13||ascii(12,4)!=='IHDR')throw Error('PNG 头部无效');dimensions(v.getUint32(16),v.getUint32(20));
  let pos=8,data=false,end=false;
  while(pos+12<=b.length){const n=v.getUint32(pos),name=ascii(pos+4,4);if(n>b.length-pos-12)throw Error('PNG 不完整');if(name==='IDAT'&&n>0)data=true;if(name==='IEND'){if(n!==0||pos+12!==b.length)throw Error('PNG 尾部无效');end=true;break;}pos+=n+12;}
  if(!data||!end)throw Error('PNG 不完整');type='image/png';ext='png';
 }else if(b.length>=16&&b[0]===255&&b[1]===216){
  byteLength=jpegLength(b,v);type='image/jpeg';ext='jpg';
 }else if(b.length>=30&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP'&&v.getUint32(4,true)+8===b.length){
  let p=12,found=false;
  while(p+8<=b.length){const name=ascii(p,4),n=v.getUint32(p+4,true),q=p+8;if(n>b.length-q)throw Error('WebP 不完整');
   if(name==='ANIM'||name==='ANMF')throw Error('暂不支持动画 WebP');
   if(name==='VP8X'){if(n!==10||b[q]&2)throw Error('WebP 扩展不支持');dimensions(1+b[q+4]+(b[q+5]<<8)+(b[q+6]<<16),1+b[q+7]+(b[q+8]<<8)+(b[q+9]<<16));}
   if(name==='VP8 '){if(n<10||b[q+3]!==157||b[q+4]!==1||b[q+5]!==42)throw Error('WebP 图像无效');dimensions(v.getUint16(q+6,true)&16383,v.getUint16(q+8,true)&16383);found=true;}
   if(name==='VP8L'){if(n<5||b[q]!==47)throw Error('WebP 图像无效');dimensions(1+b[q+1]+((b[q+2]&63)<<8),1+(b[q+2]>>6)+(b[q+3]<<2)+((b[q+4]&15)<<10));found=true;}
   p=q+n+(n%2);
  }
  if(!found||p!==b.length)throw Error('WebP 容器无效');type='image/webp';ext='webp';
 }else throw Error('仅支持真实的 JPEG、PNG、WebP 照片');
 if(declared&&declared.split(';')[0].trim()!==type)throw Error('文件类型与内容不一致');
 return {type,ext,byteLength};
}
