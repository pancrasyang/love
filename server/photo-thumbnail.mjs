import {privateResponse,authenticate,ApiError,failure} from './session.mjs';
export async function photoThumbnailHandler(req,res){privateResponse(res);try{await authenticate(req,res);throw new ApiError(410,'请刷新页面以使用原照片存储','MEDIA_STORAGE_CHANGED');}catch(error){return failure(res,error);}}
