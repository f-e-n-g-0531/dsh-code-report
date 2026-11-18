// Shared by browser and host; no Node or DSH service dependencies.
export const PACKAGE_NAME='@feng0531/dsh-code-report';
export const RPC_CHANNEL='/code-report-rpc';
export const PROTOCOL_VERSION=3;
export function runtimeGate(info,clientVersion){if(!info)return '正在确认后台版本，暂不执行扫描或分析。';if(info.packageName!==PACKAGE_NAME||info.protocol!==PROTOCOL_VERSION||info.runningVersion!==clientVersion)return '界面与后台版本或协议不一致，已停止扫描和分析。请保存配置，再手动完全退出并重新启动 DSH；只刷新页面不会重载后台。';return '';}
