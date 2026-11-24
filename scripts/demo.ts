import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api.ts';
import { processOne } from '../apps/worker.ts';
import { SimulatedMailbox } from '../packages/connectors/simulated-mailbox.ts';
import { asMember, seedWorkspace } from '../packages/db/database.ts';
import { createCampaign } from '../packages/domain/campaigns.ts';
import { startLocalPostgres } from './local-postgres.ts';
import {randomBytes} from 'node:crypto';
import {Vault} from '../packages/outreach/security.ts';
import {deliveryTick} from '../packages/outreach/delivery.ts';
import {researchTick} from '../packages/outreach/runs.ts';

const runtime = await startLocalPostgres();
const workspaceMode=process.argv.includes('--workspace');
const settings={vault:new Vault(randomBytes(32)),base:'',allowReal:false,defaultWorkspace:workspaceMode};
const api = createApi(runtime.pool,settings);
try {
  const workspaces = [await seedWorkspace(runtime.pool, 'Coffee Studio',workspaceMode?'admin':'reviewer'), await seedWorkspace(runtime.pool, 'Field Notes')];
  if(!workspaceMode)await asMember(runtime.pool, workspaces[0].token, (client, member) => createCampaign(client, member, 'Coffee collaborations'));
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const base = 'http://127.0.0.1:' + (api.address() as AddressInfo).port;
  settings.base=base;
  console.log('Mailoop local demo · simulated mail · disposable PostgreSQL');
  for (const workspace of workspaces) console.log(workspace.name + ': ' + base + '/#token=' + workspace.token);
  console.log('For the CLI, set MAILOOP_URL to the origin and MAILOOP_TOKEN to the value after #token=. Ctrl+C stops the demo.');
  const mailbox = new SimulatedMailbox(runtime.pool, process.argv.includes('--lose-receipt'));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopping) {
    for (const { workspaceId } of workspaces) {
      if(workspaceMode){
        await deliveryTick(runtime.pool,workspaceId,settings.vault,base,false);
        await researchTick(runtime.pool,workspaceId,settings.vault,base);
      }else await processOne(runtime.pool, mailbox, workspaceId);
    }
    if (!stopping) await delay(450);
  }
} finally {
  if (api.listening) await new Promise<void>(resolve => api.close(() => resolve()));
  await runtime.close();
}
