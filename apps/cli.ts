import { MailoopClient } from '../packages/client.ts';
import { readFile } from 'node:fs/promises';

const usage =
  'mailoop <list | create NAME | show ID | approve ID REVISION | events ID [AFTER] | outreach METHOD PATH [JSON_FILE] | watch campaigns|runs ID [AFTER]>';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log(usage);
    return;
  }
  const { MAILOOP_URL, MAILOOP_TOKEN } = process.env;
  if (!MAILOOP_URL || !MAILOOP_TOKEN)
    throw new Error('Set MAILOOP_URL and MAILOOP_TOKEN from the local demo.');
  const client = new MailoopClient(MAILOOP_URL.replace(/\/$/, ''), MAILOOP_TOKEN);
  if (command === 'watch') {
    const [scope, resource, after = '0'] = args;
    if (
      !['campaigns', 'runs'].includes(scope) ||
      !/^[-a-f0-9]{36}$/.test(resource) ||
      !/^\d+$/.test(after)
    )
      throw Error(usage);
    const res = await fetch(new URL('/v1/outreach/' + scope + '/' + resource + '/stream', MAILOOP_URL), {
      headers: { Authorization: 'Bearer ' + MAILOOP_TOKEN, 'Last-Event-ID': after },
      redirect: 'error'
    });
    if (!res.ok || !res.body) throw Error('Event subscription returned ' + res.status);
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  if (command === 'outreach') {
    const [method, path, file] = args;
    if (
      !['GET', 'POST', 'PATCH', 'DELETE'].includes(method) ||
      !path ||
      !/^[-\w/?=&.%]+$/.test(path) ||
      path.startsWith('/') ||
      path.includes('..')
    )
      throw Error(usage);
    const res = await fetch(new URL('/v1/outreach/' + path, MAILOOP_URL), {
      method,
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + MAILOOP_TOKEN, 'Content-Type': 'application/json' },
      body: file
        ? JSON.stringify(JSON.parse(await readFile(file, 'utf8')))
        : ['POST', 'PATCH'].includes(method)
          ? '{}'
          : undefined
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error ?? String(res.status));
    return data;
  }
  switch (command) {
    case 'list':
      if (!args.length) return client.campaigns();
      break;
    case 'create':
      if (args.length) return client.create(args.join(' '));
      break;
    case 'show':
      if (args.length === 1) return client.campaign(args[0]);
      break;
    case 'approve':
      if (args.length === 2) return client.approve(args[0], args[1]);
      break;
    case 'events':
      if (args.length >= 1 && args.length <= 2 && /^\d+$/.test(args[1] ?? '0'))
        return client.events(args[0], Number(args[1] ?? 0));
      break;
  }
  throw new Error(usage);
}
main()
  .then((result) => {
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
