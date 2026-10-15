// Shared by browser and host; no Node or DSH service dependencies.
export const PACKAGE_NAME='@feng0531/dsh-code-report';
export const RPC_CHANNEL='/code-report-rpc';
export const PROTOCOL_VERSION=1;
export function stableVersion(value){return typeof value==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)&&value.length<50;}
export function newerVersion(candidate,current){if(!stableVersion(candidate)||!stableVersion(current))return false;const a=candidate.split('.').map(BigInt),b=current.split('.').map(BigInt);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;}
