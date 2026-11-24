import { MailoopClient } from '../packages/client.ts';

const usage = 'mailoop <list | create NAME | show ID | approve ID REVISION | events ID [AFTER]>';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { console.log(usage); return; }
  const { MAILOOP_URL, MAILOOP_TOKEN } = process.env;
  if (!MAILOOP_URL || !MAILOOP_TOKEN) throw new Error('Set MAILOOP_URL and MAILOOP_TOKEN from the local demo.');
  const client = new MailoopClient(MAILOOP_URL.replace(/\/$/, ''), MAILOOP_TOKEN);
  switch (command) {
    case 'list': if (!args.length) return client.campaigns(); break;
    case 'create': if (args.length) return client.create(args.join(' ')); break;
    case 'show': if (args.length === 1) return client.campaign(args[0]); break;
    case 'approve': if (args.length === 2) return client.approve(args[0], args[1]); break;
    case 'events':
      if (args.length >= 1 && args.length <= 2 && /^\d+$/.test(args[1] ?? '0')) return client.events(args[0], Number(args[1] ?? 0));
      break;
  }
  throw new Error(usage);
}
main().then(result => { if (result !== undefined) console.log(JSON.stringify(result, null, 2)); })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
