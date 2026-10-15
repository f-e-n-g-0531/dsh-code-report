export {createHandler,sessionCwd} from './src/host.mjs';
import {createHandler} from './src/host.mjs';
import {RPC_CHANNEL} from './src/protocol.mjs';
export const name='dsh-code-report';
export const inject=['connection','sessions','sessionPersistence','llm'];
export function apply(ctx){ctx.connection.register(ctx,RPC_CHANNEL,createHandler(ctx));}
