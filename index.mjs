export {createHandler,sessionCwd} from './src/host.mjs';
import {createHandler} from './src/host.mjs';
import {RPC_CHANNEL} from './src/protocol.mjs';
export const name='dsh-code-report';
// agentDefaultModel is deliberately optional; the handler uses ctx.get when previewing.
export const inject=['connection','webServer','sessions','sessionPersistence','llm'];
export function apply(ctx){ctx.connection.register(ctx,RPC_CHANNEL,createHandler(ctx));}
