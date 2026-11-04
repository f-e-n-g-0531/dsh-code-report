import {RPC_CHANNEL} from './protocol.mjs';
export function connectionMessage(error,endpoint){const text=error?.message||String(error);if(/Failed to fetch|fetch failed|NetworkError|Load failed/i.test(text))return '连接在'+(endpoint||'请求')+'阶段中断，后台任务结果尚未确认。不要据此重复提交生成，也不要直接重启；请保留页面并查询原任务。 原始错误：'+text;if(/HTTP (404|405)|transport failure/.test(text))return '插件后台连接失败，项目尚未扫描。界面版本不代表后台已经更新：若刚安装或更新过，请先保存工作，再手动完全退出并重新启动 DSH（只刷新页面不会重载后台）。若重启后仍失败，请到 DSH「插件」页面确认插件已启用，并提供下方原始错误。 原始错误：'+text;return text;}
export function createClientRpc(connection){
 return async(endpoint,payload,signal)=>{
  try{
   const result=await connection.rpc.call(RPC_CHANNEL,endpoint,payload,signal);
   if(!result.ok){const error=new Error(result.error?.message||'请求失败');error.code=result.error?.code;error.details=result.error?.details;throw error;}
   return result.value;
  }catch(error){
   if(signal?.aborted)throw error;
   const wrapped=new Error(connectionMessage(error,endpoint),{cause:error});
   wrapped.code=error?.code;wrapped.details=error?.details;throw wrapped;
  }
 };
}
