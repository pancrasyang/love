import {ApiError} from './session.mjs';

// Transport policy must never be used to derive file, cache, or memory limits.
export const DEFAULT_PART_SIZE=1048576;
export const PART_SIZES=Object.freeze([1048576,2097152,3145728]);
export const MAX_R2_BYTES=10485760,MAX_LEGACY_BYTES=20971520;

export function originalPartSize(){
 const value=process.env.PHOTO_ORIGINAL_PART_SIZE;
 if(value===undefined||value==='')return DEFAULT_PART_SIZE;
 if(!PART_SIZES.some(size=>String(size)===value))throw new ApiError(503,'原图分段配置异常','MEDIA_PART_CONFIG');
 return Number(value);
}
export function requestPartSize(url){
 const value=url.searchParams.get('part_size');
 if(value===null)return DEFAULT_PART_SIZE; // Old pages always retain their 1MiB offsets.
 if(url.searchParams.getAll('part_size').length!==1||!PART_SIZES.some(size=>String(size)===value)||url.searchParams.get('meta')==='1'||url.searchParams.get('source')!=='r2'||(url.searchParams.get('variant')||'original')!=='original'||!url.searchParams.has('part')||!url.searchParams.has('version'))throw new ApiError(400,'照片分段参数不正确','MEDIA_INPUT');
 return Number(value);
}
export function partBounds(part,partSize,size){
 const start=part*partSize,end=Math.min(start+partSize-1,size-1);
 if(!Number.isSafeInteger(part)||part<0||!PART_SIZES.includes(partSize)||!Number.isSafeInteger(size)||size<=0||!Number.isSafeInteger(start)||start>=size)throw new ApiError(416,'照片分段范围不正确','MEDIA_RANGE_INVALID');
 return {start,end,count:Math.ceil(size/partSize)};
}
export function withPartSize(meta,source='r2'){
 return source==='r2'&&meta.variant==='original'?{...meta,part_size:originalPartSize()}:meta;
}
