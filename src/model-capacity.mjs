// No tokenizer is exposed by the host. One serialized UTF-8 byte per token is
// deliberately conservative; this is an estimate, never a tokenizer bound or server guarantee.
export async function modelCapacity(llm,route){
 const fallback={source:'fallback',contextWindow:null,outputTokens:8192,inputBudget:64000,warning:'宿主未提供该模型的有效上下文容量，暂用兼容预算 64000 字节；可手动降低，不能据此推断模型上限。'};
 if(!route||typeof llm?.resolveModelInfo!=='function')return fallback;
 let info;try{info=await llm.resolveModelInfo(route.provider,route.model);}catch{return fallback;}
 const contextWindow=info?.context?.contextWindow;
 if(!Number.isSafeInteger(contextWindow)||contextWindow<=0)return fallback;
 const configured=info?.defaultMaxTokens;
 const outputTokens=Number.isSafeInteger(configured)&&configured>0?Math.min(32768,configured):8192;
 const safetyTokens=Math.max(1024,Math.ceil(contextWindow/10));
 const inputBudget=contextWindow-outputTokens-safetyTokens;
 if(!Number.isSafeInteger(inputBudget)||inputBudget<4000)throw Object.assign(new Error('模型上下文不足以容纳输出预留和安全余量，请检查模型配置'),{code:'code-report/model-capacity'});
 return {policyVersion:1,source:'host-model',provider:route.provider,model:route.model,contextWindow,outputTokens,safetyTokens,inputBudget,warning:'按序列化 UTF-8 字节作保守 token 工程估算（非数学上界），非精确 tokenizer；配置容量不等于服务端保证。'};
}
