import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

const requests=new AsyncLocalStorage();
export const requestDiagnostics=()=>requests.getStore();

// Log only fixed stage names, status codes and timings, never URLs or payloads.
export async function measure(stage,action){
 const trace=requestDiagnostics(),began=Date.now();if(trace)trace.stage=stage;
 try{
  const result=await action();
  trace?.stages.push({stage,status:result?.status||200,elapsed_ms:Date.now()-began});
  return result;
 }catch(error){
  trace?.stages.push({stage,status:error.status||503,elapsed_ms:Date.now()-began});
  throw error;
 }
}

export function withDiagnostics(res,action,{photo=false}={}){
 const trace={request_id:randomUUID(),stage:'request',stages:[]},began=Date.now();
 res.setHeader('X-Love-Request-Id',trace.request_id);
 if(photo)res.setHeader('X-Photo-Request-Id',trace.request_id);
 return requests.run(trace,async()=>{
  try{return await action();}
  finally{
   const status=res.statusCode||200;
   console[status>=400?'warn':'info'](JSON.stringify({...trace,status,elapsed_ms:Date.now()-began}));
  }
 });
}
