import {ApiError} from './session.mjs';
// Existing previews share production Supabase configuration. Never test writes there.
export function requirePreviewWriteTarget(){
 if(process.env.VERCEL_ENV!=='preview')return;
 if(process.env.LOVE_STORAGE_PREVIEW_WRITES!=='isolated'||new URL(process.env.SUPABASE_URL).hostname==='oemwxlvdpowjxhipcqil.supabase.co')throw new ApiError(503,'此预览仅供只读核验，尚未连接独立测试存储','PREVIEW_READ_ONLY');
}
