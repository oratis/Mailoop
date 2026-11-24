import { researchSchema } from './imports.ts';
type Schema = Record<string, unknown>;
const text = { type: 'string' },
  uuid = { type: 'string', format: 'uuid' },
  date = { type: 'string', format: 'date-time' };
const array = (items: Schema) => ({ type: 'array', items });
const object = (properties: Record<string, Schema>, required: string[] = []) => ({
  type: 'object',
  properties,
  required
});
const strings = (...values: string[]) => ({ type: 'string', enum: values });
const fields = (...names: string[]) => Object.fromEntries(names.map((k) => [k, text]));
const input = (name: string) => ({ $ref: '#/components/schemas/' + name });
const anyObject = { type: 'object', additionalProperties: true };
const bodies: Record<string, Schema> = {
  Campaign: object(
    {
      ...fields('name', 'brief', 'purpose', 'region', 'timezone'),
      windowStart: { type: 'integer', minimum: 0, maximum: 23 },
      windowEnd: { type: 'integer', minimum: 1, maximum: 24 },
      cap: { type: 'integer', minimum: 1, maximum: 5000 },
      facts: array(object({ text, expiresAt: date }, ['text', 'expiresAt']))
    },
    ['name', 'brief', 'purpose', 'region']
  ),
  ResearchRun: object(
    {
      bindingId: uuid,
      requestKey: text,
      budget: { type: 'integer', minimum: 1, maximum: 100 },
      urls: array({ type: 'string', format: 'uri' }),
      maxPages: { type: 'integer', minimum: 1, maximum: 12 }
    },
    ['bindingId', 'requestKey']
  ),
  ResearchArtifact: { $ref: '/schemas/research-result.json' },
  Preview: object({ previewId: uuid, digest: text }, ['previewId', 'digest']),
  Approval: object(
    { items: array(object({ id: uuid, revision: uuid, dueAt: date }, ['id', 'revision'])) },
    ['items']
  ),
  Draft: object({
    step: strings('first', 'followup', 'reply'),
    mailboxId: uuid,
    parentId: uuid,
    bindingId: uuid,
    ...fields('subject', 'body', 'templateVersion')
  }),
  Permission: object({
    action: strings('revoke'),
    confirmed: { type: 'boolean' },
    proof: text,
    expiresAt: date
  }),
  Outcome: object(
    {
      ...fields('source', 'externalId', 'currency'),
      occurredAt: date,
      amount: { type: 'number', minimum: 0 },
      kind: strings('won', 'published', 'conversion', 'cost')
    },
    ['source', 'externalId', 'kind', 'occurredAt']
  ),
  Binding: object(
    {
      provider: strings('openai', 'anthropic', 'gemini', 'local-artifact'),
      model: text,
      key: { type: 'string', writeOnly: true }
    },
    ['provider', 'model']
  ),
  RunAction: object(
    {
      action: strings('claim', 'submit', 'resume', 'cancel'),
      ticket: uuid,
      artifact: input('ResearchArtifact'),
      budget: { type: 'integer' }
    },
    ['action']
  ),
  Invite: object(
    { name: text, role: strings('operator', 'reviewer', 'researcher', 'analyst', 'viewer') },
    ['name', 'role']
  )
};
const paths: Record<string, Record<string, unknown>> = {};
function op(
  verb: string,
  path: string,
  summary: string,
  body?: Schema,
  query: string[] = [],
  eventStream = false
) {
  const key = '/v1/outreach/' + path;
  const parameters = [...path.matchAll(/\{(\w+)\}/g)].map(([_, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: name === 'name' ? text : uuid
  }));
  const operation = {
    summary,
    operationId: verb + '_' + path.replace(/[^a-z0-9]+/gi, '_').replace(/_$/, ''),
    parameters: [...parameters, ...query.map((name) => ({ name, in: 'query', schema: text }))],
    ...(body && { requestBody: { required: true, content: { 'application/json': { schema: body } } } }),
    responses: {
      '200': {
        description: 'Success',
        content: {
          [eventStream ? 'text/event-stream' : 'application/json']: { schema: eventStream ? text : {} }
        }
      },
      default: {
        description: 'Request error',
        content: { 'application/json': { schema: object({ error: text }, ['error']) } }
      }
    }
  };
  (paths[key] ??= {})[verb] = operation;
}
op('get', 'campaigns', 'List available campaigns');
op('post', 'campaigns', 'Create a campaign', input('Campaign'));
op('get', 'campaigns/{id}', 'Read the campaign workspace');
op('get', 'campaigns/{id}/report', 'Calculate a cohort report', undefined, [
  'from',
  'to',
  'mailbox',
  'owner',
  'template',
  'region'
]);
op('get', 'campaigns/{id}/events', 'Read activity after the supplied sequence', undefined, ['after']);
for (const scope of ['campaigns', 'runs'])
  op(
    'get',
    scope + '/{id}/stream',
    'Subscribe to permission-scoped activity',
    undefined,
    ['after'],
    true
  );
for (const [route, schema] of Object.entries({
  preview: 'ResearchArtifact',
  apply: 'Preview',
  approve: 'Approval',
  runs: 'ResearchRun'
}))
  op('post', 'campaigns/{id}/' + route, 'Campaign ' + route, input(schema));
for (const route of ['share', 'status', 'brief'])
  op('post', 'campaigns/{id}/' + route, 'Change campaign ' + route, anyObject);
op('post', 'runs/{id}', 'Change run state or submit a local artifact', input('RunAction'));
op('get', 'previews/{id}', 'Read import decisions');
for (const route of ['members', 'bindings', 'mailboxes', 'skills', 'connectors'])
  op('get', route, 'List ' + route);
op('get', 'skills/{name}', 'Read installed skill instructions');
op('post', 'members', 'Invite a workspace member', input('Invite'));
op('delete', 'members/{id}', 'Remove a workspace member');
op('post', 'bindings', 'Register a member model binding', input('Binding'));
op('delete', 'bindings/{id}', 'Revoke a model binding');
op('post', 'mailboxes', 'Verify and connect a simulator, TLS or installed connector', anyObject);
op(
  'post',
  'mailboxes/connect',
  'Start mailbox OAuth',
  object({ provider: strings('gmail', 'feishu', 'graph', 'nylas') }, ['provider'])
);
for (const action of ['grant', 'bridge'])
  op('post', 'mailboxes/{id}/' + action, 'Manage mailbox ' + action, anyObject);
op('get', 'mailboxes/{id}/unmatched', 'Read minimal unmatched envelopes as mailbox owner');
for (const [route, schema] of Object.entries({
  permission: 'Permission',
  drafts: 'Draft',
  outcome: 'Outcome'
}))
  op('post', 'creators/{id}/' + route, 'Record creator ' + route, input(schema));
for (const action of ['suppress', 'shortlist', 'merge', 'contact'])
  op('post', 'creators/{id}/' + action, 'Change creator ' + action, anyObject);
op('get', 'creators/{id}/relationships', 'Read authorized campaign history');
op('delete', 'creators/{id}', 'Erase creator content and suppress the contact point');
op(
  'patch',
  'letters/{id}',
  'Edit an exact letter revision',
  object({ revision: uuid, subject: text, body: text }, ['revision', 'subject', 'body'])
);
op('get', 'letters/{id}/history', 'Read previous letter revisions');
for (const action of ['cancel', 'simulate'])
  op('post', 'letters/{id}/' + action, 'Letter ' + action, anyObject);
op('post', 'inbox/{id}', 'Classify and handle a reply', anyObject);
op('get', 'policy', 'Get data retention');
op(
  'post',
  'policy',
  'Set optional retention',
  object({ retentionDays: { type: ['integer', 'null'] } }, ['retentionDays'])
);
export const openapi = {
  openapi: '3.1.0',
  info: { title: 'Mailoop workspace API', version: '0.1.0' },
  paths,
  security: [{ member: [] }],
  components: { securitySchemes: { member: { type: 'http', scheme: 'bearer' } }, schemas: bodies }
};
export { researchSchema };
