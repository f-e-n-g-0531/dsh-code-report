import {PACKAGE_NAME,stableVersion,newerVersion} from './protocol.mjs';
export function updateOutcome(result){
 if(!result?.ok)return {state:'unknown',message:'未收到可靠的更新结果。安装可能仍在进行，请到 DSH「插件」页面检查，不要重复点击更新。'};
 const value=result.value;
 if(value?.application==='failed')return {state:'failed',message:'更新失败，未确认新版生效。请在 DSH「插件」页面查看详情：'+(value.error?.code||'安装错误')};
 if(value?.application==='cancelled')return {state:'cancelled',message:'更新已取消，新版未确认生效。'};
 if(value?.application==='restart-required')return {state:'restart-required',message:'新版已安装，但当前 DSH 后台仍在运行旧版。请先保存或下载报告，再自行重启 DSH 并刷新页面。插件不会自动重启。'};
 if(value?.application==='applied')return {state:'applied',message:'宿主报告更新已应用。请先下载报告，再刷新页面加载新版界面；若前后端版本仍不一致，请手动重启 DSH。'};
 return {state:'unknown',message:'宿主未确认新版已生效，请到 DSH「插件」页面检查安装与启用状态。'};
}
export async function installUpdate(manager,info,{confirmed=false,requestId}={}){
 if(!confirmed)throw new Error('需要先确认更新');
 if(!stableVersion(info?.latestVersion)||!newerVersion(info.latestVersion,info.runningVersion))throw new Error('没有可安装的新版本');
 if(!manager||typeof manager.installBundle!=='function')throw new Error('当前 DSH 不支持此更新接口，请到「插件」页面手动更新');
 try{return updateOutcome(await manager.installBundle(PACKAGE_NAME+'@'+info.latestVersion,{enabled:false,registry:'https://registry.npmjs.org/',requestId}));}catch{return updateOutcome(null);}
}
