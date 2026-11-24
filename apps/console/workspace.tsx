import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Member } from '../../packages/db/database.ts';
import type { Candidate } from '../../packages/outreach/imports.ts';
import './style.css';
import './workspace.css';
type Program = {
  id: string;
  name: string;
  brief: string;
  status: string;
  purpose: string;
  region: string;
  version: number;
  facts: { text: string; expiresAt: string }[];
};
type Creator = Candidate & { id: string; verified: boolean; shortlisted: boolean; stage: string };
type Letter = {
  id: string;
  revision: string;
  receipt?: string;
  prospect_id: string;
  status: string;
  reason?: string;
  step: string;
  subject: string;
  body: string;
  from: string;
  to: string;
};
type Box = {
  id: string;
  owner_id: string;
  address: string;
  provider: string;
  active: boolean;
  cap: number;
};
type Binding = { id: string; provider: string; model: string; active: boolean };
type Preview = { previewId: string; digest: string; decisions: string[] };
type Reply = {
  id: string;
  letter_id: string;
  kind: string;
  text: string;
  handled_at?: string;
  assignee_id?: string;
};
type Run = { id: string; status: string; step: string; calls: number; budget: number; note?: string };
type Metric = { numerator: number; denominator: number; rate: number | null };
type Summary = {
  cohort: { id: string; replied: boolean; interested: boolean; first_reply_ids: string[] }[];
  observing: boolean;
  usageCosts: {
    kind: string;
    provider: string;
    currency: string | null;
    requests: number;
    unpriced: number;
    estimated_amount: string | null;
  }[];
  daily: { day: string; kind: string; count: number }[];
  handlingSeconds: { p50: number | null; p90: number | null; overdue: number };
  shortlist: Metric;
  contactable: Metric;
  reply: Metric;
  interest: Metric;
  unsubscribe: Metric;
  won: Metric;
  hardBounce: Metric;
  byState: { status: string; count: number }[];
  costs: { currency: string; amount: string }[];
  timezone: string;
  watermark: string;
};
type Detail = {
  campaign: Program;
  prospects: Creator[];
  letters: Letter[];
  inbox: Reply[];
  runs: Run[];
  summary: Summary;
  events: { seq: string; type: string; at: string }[];
};
const incoming = new URLSearchParams(location.hash.slice(1)).get('token');
if (incoming) {
  sessionStorage.setItem('mailoop-token', incoming);
  history.replaceState(null, '', location.pathname);
}
const token = () => sessionStorage.getItem('mailoop-token') ?? '';
async function request<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST'
): Promise<T> {
  const res = await fetch(path.startsWith('/v1/') ? path : '/v1/outreach/' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}
const expiry = () => new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
type Data = Record<string, string>;
function Form({
  children,
  label,
  run
}: {
  children: ReactNode;
  label: string;
  run: (d: Data) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = e.currentTarget;
    try {
      await run(Object.fromEntries(new FormData(form)) as Data);
      for (const field of form.querySelectorAll<HTMLInputElement>('input[type=password]'))
        field.value = '';
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="workspace-form" onSubmit={submit}>
      {children}
      <button disabled={busy}>{busy ? 'Working…' : label}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function Input({
  name,
  label,
  type = 'text',
  value = '',
  optional = false
}: {
  name: string;
  label: string;
  type?: string;
  value?: string;
  optional?: boolean;
}) {
  return (
    <label>
      {label}
      {type === 'textarea' ? (
        <textarea name={name} defaultValue={value} required={!optional} />
      ) : (
        <input name={name} type={type} defaultValue={value} required={!optional} />
      )}
    </label>
  );
}
function Select({ name, label, options }: { name: string; label: string; options: [string, string][] }) {
  return (
    <label>
      {label}
      <select name={name} required={!options.some(([value]) => value === '')}>
        {options.map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}
function App() {
  const [me, setMe] = useState<Member>(),
    [campaigns, setCampaigns] = useState<Program[]>([]),
    [selected, select] = useState(''),
    [detail, setDetail] = useState<Detail>();
  const [boxes, setBoxes] = useState<Box[]>([]),
    [bindings, setBindings] = useState<Binding[]>([]),
    [members, setMembers] = useState<Member[]>([]);
  const [tab, setTab] = useState('Campaign'),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [tick, reload] = useState(0),
    [preview, setPreview] = useState<Preview>();
  const [file, setFile] = useState<File>(),
    [invitation, setInvitation] = useState(''),
    [checked, setChecked] = useState<string[]>([]),
    [filteredReport, setFilteredReport] = useState<Summary>();
  const refresh = () => reload((x) => x + 1);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const [member, rows, m, keys, team] = await Promise.all([
          request<Member>('/v1/me'),
          request<Program[]>('campaigns'),
          request<Box[]>('mailboxes'),
          request<Binding[]>('bindings'),
          request<Member[]>('members')
        ]);
        const active = rows.find((c) => c.id === selected)?.id ?? rows[0]?.id ?? '';
        const d = active ? await request<Detail>('campaigns/' + active) : undefined;
        if (live) {
          setMe(member);
          setCampaigns(rows);
          setBoxes(m);
          setBindings(keys);
          setMembers(team);
          setDetail(d);
          setError('');
          if (active !== selected) select(active);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(load, 5000);
      }
    }
    if (token()) void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tick, selected]);
  useEffect(() => {
    setPreview(undefined);
    setChecked([]);
    setFilteredReport(undefined);
  }, [selected]);
  const p = detail?.campaign,
    path = 'campaigns/' + selected;
  const modify = async (endpoint: string, b: unknown, method?: string) => {
    await request(endpoint, b, method);
    setNotice('Saved');
    refresh();
  };
  const knownBindings: [string, string][] = bindings
    .filter((b) => b.active)
    .map((b) => [b.id, b.provider + ' · ' + b.model]);
  const knownBoxes: [string, string][] = boxes
    .filter((b) => b.active)
    .map((b) => [b.id, b.address + ' · ' + b.provider]);
  const reviewer = me?.role === 'admin' || me?.role === 'reviewer',
    operate = reviewer || me?.role === 'operator',
    research = operate || me?.role === 'researcher';
  const summary = filteredReport ?? detail?.summary;
  function exportReport() {
    if (!summary) return;
    const blob = new Blob([JSON.stringify({ ...summary, cohort: undefined }, null, 2)], {
        type: 'application/json'
      }),
      url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = 'mailoop-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <header className="top">
        <span className="wordmark">Mailoop</span>
        <span>{me?.workspaceName ?? 'Workspace'}</span>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">Creator partnerships</p>
            <h1>{p?.name ?? 'Campaign workspace'}</h1>
          </div>
          {me && (
            <span>
              {me.name} · {me.role}
            </span>
          )}
        </div>
        {!token() ? (
          <Form
            label="Open workspace"
            run={async (d) => {
              sessionStorage.setItem('mailoop-token', d.token);
              refresh();
            }}
          >
            <Input name="token" type="password" label="Workspace access token" />
          </Form>
        ) : (
          <>
            <div className="toolbar">
              <label>
                Campaign
                <select
                  value={selected}
                  onChange={(e) => {
                    select(e.target.value);
                    setDetail(undefined);
                  }}
                >
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="subtle"
                onClick={() => {
                  sessionStorage.removeItem('mailoop-token');
                  location.reload();
                }}
              >
                Sign out
              </button>
            </div>
            <nav className="tabs" aria-label="Workspace sections">
              {[
                'Campaign',
                ...(research ? ['Research', 'Creators'] : []),
                ...(operate ? ['Outbox', 'Inbox'] : []),
                'Reports',
                'Connections'
              ].map((t) => (
                <button
                  key={t}
                  aria-current={tab === t}
                  onClick={() => {
                    setTab(t);
                    setNotice('');
                  }}
                >
                  {t}
                </button>
              ))}
            </nav>
            {error && <p role="alert">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            {tab === 'Campaign' && (
              <div className="workgrid">
                <section>
                  <h2>Campaign brief</h2>
                  {p ? (
                    <>
                      <p>{p.brief}</p>
                      <p>
                        {p.region} · {p.purpose} · {p.status} · revision {p.version}
                      </p>
                      {operate && (
                        <>
                          <Form
                            label={p.status === 'active' ? 'Pause' : 'Activate'}
                            run={() =>
                              modify(path + '/status', {
                                status: p.status === 'active' ? 'paused' : 'active'
                              })
                            }
                          >
                            <></>
                          </Form>
                          <details>
                            <summary>Edit brief and facts</summary>
                            <Form
                              key={p.version}
                              label="Save revision"
                              run={(d) =>
                                modify(path + '/brief', {
                                  brief: d.brief,
                                  version: p.version,
                                  facts: JSON.parse(d.facts)
                                })
                              }
                            >
                              <Input name="brief" label="Brief" type="textarea" value={p.brief} />
                              <Input
                                name="facts"
                                label="Brand facts (JSON array of text and expiresAt)"
                                type="textarea"
                                value={JSON.stringify(p.facts)}
                              />
                            </Form>
                          </details>
                        </>
                      )}
                      {(me?.role === 'admin' || operate) && (
                        <details>
                          <summary>Campaign access</summary>
                          <Form label="Grant access" run={(d) => modify(path + '/share', d)}>
                            <Select
                              name="memberId"
                              label="Member"
                              options={members.map((m) => [m.id, m.name])}
                            />
                          </Form>
                        </details>
                      )}
                    </>
                  ) : (
                    <p>Create your first campaign.</p>
                  )}
                </section>
                {operate && (
                  <section>
                    <h2>New campaign</h2>
                    <Form
                      label="Create campaign"
                      run={async (d) => {
                        const result = await request<Program>('campaigns', d);
                        select(result.id);
                        refresh();
                      }}
                    >
                      <Input name="name" label="Name" />
                      <Input name="brief" label="Audience brief" type="textarea" />
                      <Input name="purpose" label="Contact purpose" />
                      <Input name="region" label="Recipient market" />
                      <Input name="timezone" value="UTC" label="Send timezone" />
                    </Form>
                  </section>
                )}
              </div>
            )}
            {p && tab === 'Research' && (
              <div className="workgrid">
                <section>
                  <h2>Research run</h2>
                  <p>{p.brief}</p>
                  <Form
                    label="Start research"
                    run={async (d) =>
                      modify(path + '/runs', {
                        bindingId: d.bindingId,
                        urls: d.urls.split(/[\s,]+/).filter(Boolean),
                        budget: Number(d.budget),
                        language: d.language,
                        publishedAfter: d.publishedAfter,
                        maxCandidates: Number(d.maxCandidates),
                        requestKey: crypto.randomUUID()
                      })
                    }
                  >
                    <Select name="bindingId" label="Model binding" options={knownBindings} />
                    <Input
                      name="urls"
                      label="Public source URLs (leave empty to use configured search)"
                      optional
                      type="textarea"
                    />
                    <Input name="language" label="Required language code" optional />
                    <Input name="publishedAfter" label="Earliest work date" type="date" optional />
                    <Input name="maxCandidates" label="Maximum candidates" type="number" value="100" />
                    <Input name="budget" label="Maximum paid calls" type="number" value="2" />
                  </Form>
                  {detail?.runs.map((r) => (
                    <article key={r.id}>
                      <b>
                        {r.step} · {r.status}
                      </b>
                      <p>
                        {r.calls}/{r.budget} calls · {r.id}
                      </p>
                      {r.status === 'completed' ? (
                        <Form
                          label="Review result"
                          run={async () => setPreview(await request<Preview>('previews/' + r.note))}
                        >
                          <></>
                        </Form>
                      ) : (
                        r.note && <p>{r.note}</p>
                      )}
                      {['failed', 'interrupted', 'waiting_auth', 'waiting_budget'].includes(
                        r.status
                      ) && (
                        <Form
                          label="Resume"
                          run={(d) =>
                            modify('runs/' + r.id, { action: 'resume', budget: Number(d.budget) })
                          }
                        >
                          <Input
                            name="budget"
                            type="number"
                            value={String(r.budget)}
                            label="Call budget"
                          />
                        </Form>
                      )}
                    </article>
                  ))}
                </section>
                <section>
                  <h2>Research import</h2>
                  <p>Use brief revision {p.version}. Preview the row decisions before importing.</p>
                  <Form
                    label="Preview artifact"
                    run={async () => {
                      if (!file) throw Error('Select a JSON file.');
                      setPreview(
                        await request<Preview>(path + '/preview', JSON.parse(await file.text()))
                      );
                    }}
                  >
                    <label>
                      Research JSON
                      <input
                        required
                        type="file"
                        accept=".json,application/json"
                        onChange={(e) => setFile(e.target.files?.[0])}
                      />
                    </label>
                  </Form>
                  {preview && (
                    <>
                      <ol>
                        {preview.decisions.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ol>
                      <Form
                        label="Apply reviewed import"
                        run={async () => {
                          await modify(path + '/apply', preview);
                          setPreview(undefined);
                        }}
                      >
                        <></>
                      </Form>
                    </>
                  )}
                </section>
              </div>
            )}
            {p && tab === 'Creators' && (
              <section>
                <h2>Creator records</h2>
                {detail?.summary.cohort.some((c) => c.interested) && (
                  <details>
                    <summary>Interested creators</summary>
                    <ul>
                      {detail.summary.cohort
                        .filter((c) => c.interested)
                        .map((c) => (
                          <li key={c.id}>
                            {detail.prospects.find((row) => row.id === c.id)?.displayName ?? c.id}
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
                {!detail?.prospects.length && <p>Import research to build a shortlist.</p>}
                {detail?.prospects.map((c) => (
                  <details key={c.id}>
                    <summary>
                      {c.displayName} · {c.stage}
                    </summary>
                    <p>{c.matchReason}</p>
                    <p>{c.work.url}</p>
                    {c.contacts.map((pt) => (
                      <p key={pt.address}>
                        {pt.address} · {pt.source} · {pt.evidenceUrl ?? pt.recordRef}
                      </p>
                    ))}
                    {operate && c.contacts.length > 1 && (
                      <Form
                        label="Select contact"
                        run={(d) => modify('creators/' + c.id + '/contact', { index: Number(d.index) })}
                      >
                        <Select
                          name="index"
                          label="Business contact"
                          options={c.contacts.map((v, i) => [String(i), v.address])}
                        />
                      </Form>
                    )}
                    {reviewer && detail.prospects.length > 1 && (
                      <details>
                        <summary>Merge another channel</summary>
                        <Form
                          label="Confirm same creator"
                          run={(d) => modify('creators/' + c.id + '/merge', d)}
                        >
                          <Select
                            name="duplicateId"
                            label="Duplicate creator"
                            options={detail.prospects
                              .filter((v) => v.id !== c.id)
                              .map((v) => [v.id, v.displayName])}
                          />
                        </Form>
                      </details>
                    )}
                    {operate && (
                      <Form
                        label={c.shortlisted ? 'Remove from shortlist' : 'Shortlist creator'}
                        run={() =>
                          modify('creators/' + c.id + '/shortlist', { selected: !c.shortlisted })
                        }
                      >
                        <></>
                      </Form>
                    )}
                    {reviewer && c.contacts.length > 0 && (
                      <Form
                        label="Record verified consent"
                        run={(d) =>
                          modify('creators/' + c.id + '/permission', { ...d, confirmed: true })
                        }
                      >
                        <Input
                          name="proof"
                          label={'Consent evidence for ' + p.purpose + ' in ' + p.region}
                        />
                        <Input name="expiresAt" label="Consent expiry" type="date" value={expiry()} />
                      </Form>
                    )}
                    {operate && c.contacts.length > 0 && (
                      <Form
                        label="Create first draft"
                        run={(d) => modify('creators/' + c.id + '/drafts', d)}
                      >
                        <Select name="mailboxId" label="Delegated sender" options={knownBoxes} />
                        <Select
                          name="bindingId"
                          label="Composition"
                          options={[
                            ['', 'Manual draft'],
                            ...knownBindings.filter((v) => !v[1].startsWith('local-artifact'))
                          ]}
                        />
                        <Input name="subject" label="Subject for manual draft" optional />
                        <Input name="body" type="textarea" label="Body for manual draft" optional />
                      </Form>
                    )}
                    {operate && (
                      <Form
                        label="Record outcome"
                        run={(d) =>
                          modify('creators/' + c.id + '/outcome', {
                            ...d,
                            occurredAt: new Date().toISOString()
                          })
                        }
                      >
                        <Select
                          name="kind"
                          label="Outcome"
                          options={['won', 'published', 'conversion'].map((x) => [x, x])}
                        />
                        <Input name="source" label="Source system" />
                        <Input name="externalId" label="External reference" />
                      </Form>
                    )}
                  </details>
                ))}
              </section>
            )}
            {p && tab === 'Outbox' && (
              <section>
                <h2>Outbox</h2>
                {!detail?.letters.length && <p>Draft a message from a creator record.</p>}
                {detail?.letters.map((l) => (
                  <details key={l.id}>
                    <summary>
                      {l.subject} · {l.status}
                      {l.reason ? ' · ' + l.reason : ''}
                    </summary>
                    <p>
                      {l.from} → {l.to}
                    </p>
                    <pre>{l.body}</pre>
                    {l.status === 'provider_draft' && (
                      <p>Cloud draft {l.receipt} is awaiting action in the member’s mailbox.</p>
                    )}
                    <p>Each approved message includes the workspace unsubscribe link.</p>
                    {reviewer && ['draft', 'held'].includes(l.status) && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={checked.includes(l.id + '@' + l.revision)}
                          onChange={(e) =>
                            setChecked(
                              e.target.checked
                                ? [...checked, l.id + '@' + l.revision]
                                : checked.filter((x) => x !== l.id + '@' + l.revision)
                            )
                          }
                        />
                        Approve this revision
                      </label>
                    )}
                    {['draft', 'held', 'scheduled'].includes(l.status) && (
                      <>
                        <Form
                          label="Save edited revision"
                          run={(d) => modify('letters/' + l.id, { ...d, revision: l.revision }, 'PATCH')}
                        >
                          <Input name="subject" label="Subject" value={l.subject} />
                          <Input name="body" type="textarea" label="Message" value={l.body} />
                        </Form>
                        <Form
                          label="Cancel message"
                          run={() => modify('letters/' + l.id + '/cancel', {})}
                        >
                          <></>
                        </Form>
                      </>
                    )}
                    {l.status === 'accepted' && (
                      <Form
                        label="Draft follow-up"
                        run={(d) =>
                          modify('creators/' + l.prospect_id + '/drafts', {
                            ...d,
                            step: 'followup',
                            parentId: l.id
                          })
                        }
                      >
                        <Input name="subject" label="Subject" value={'Re: ' + l.subject} />
                        <Input name="body" label="Follow-up" type="textarea" />
                      </Form>
                    )}
                  </details>
                ))}
                {reviewer && checked.length > 0 && (
                  <Form
                    label={'Approve ' + checked.length + ' selected'}
                    run={async (d) => {
                      await modify(path + '/approve', {
                        items: checked.map((value) => {
                          const [id, revision] = value.split('@');
                          return { id, revision, ...(d.at && { dueAt: new Date(d.at).toISOString() }) };
                        })
                      });
                      setChecked([]);
                    }}
                  >
                    <Input
                      name="at"
                      label="Schedule (local time, optional)"
                      type="datetime-local"
                      optional
                    />
                  </Form>
                )}
              </section>
            )}
            {p && tab === 'Inbox' && (
              <section>
                <h2>Inbox</h2>
                {!detail?.inbox.length && <p>Matched replies will appear here.</p>}
                {detail?.inbox.map((i) => (
                  <details key={i.id}>
                    <summary>
                      {i.kind} · {i.handled_at ? 'Handled' : 'Needs attention'}
                    </summary>
                    <pre>{i.text}</pre>
                    {i.assignee_id ? (
                      <p>
                        Assigned to{' '}
                        {members.find((m) => m.id === i.assignee_id)?.name ?? 'a team member'}
                      </p>
                    ) : (
                      <Form
                        label="Claim conversation"
                        run={() => modify('inbox/' + i.id, { action: 'claim' })}
                      >
                        <></>
                      </Form>
                    )}
                    <Form label="Mark handled" run={(d) => modify('inbox/' + i.id, d)}>
                      <Select
                        name="kind"
                        label="Classification"
                        options={[
                          'reply',
                          'quote',
                          'interested',
                          'declined',
                          'question',
                          'auto_reply',
                          'opt_out'
                        ].map((v) => [v, v])}
                      />
                    </Form>
                    <Form
                      label="Draft thread reply"
                      run={(d) =>
                        modify(
                          'creators/' +
                            detail.letters.find((l) => l.id === i.letter_id)!.prospect_id +
                            '/drafts',
                          { step: 'reply', parentId: i.letter_id, ...d }
                        )
                      }
                    >
                      <Input name="subject" label="Subject" />
                      <Input name="body" label="Reply" type="textarea" />
                    </Form>
                  </details>
                ))}
              </section>
            )}
            {p && tab === 'Reports' && summary && (
              <section>
                <h2>Campaign report</h2>
                <Form
                  label="Apply dates"
                  run={async (d) =>
                    setFilteredReport(await request<Summary>(path + '/report?' + new URLSearchParams(d)))
                  }
                >
                  <Input name="from" type="date" label="From" optional />
                  <Input name="to" type="date" label="To (exclusive)" optional />
                  <Select
                    name="mailbox"
                    label="Mailbox"
                    options={[['', 'All senders'], ...knownBoxes]}
                  />
                  <Select
                    name="owner"
                    label="Mailbox owner"
                    options={[
                      ['', 'All owners'],
                      ...members.map((m) => [m.id, m.name] as [string, string])
                    ]}
                  />
                  <Input name="template" label="Template version" optional />
                  <Input name="region" label="Market" optional />
                </Form>
                <table>
                  <thead>
                    <tr>
                      <th>14-day cohort</th>
                      <th>Count</th>
                      <th>Denominator</th>
                      <th>Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        'reply',
                        'interest',
                        'hardBounce',
                        'unsubscribe',
                        'won',
                        'shortlist',
                        'contactable'
                      ] as const
                    ).map((k) => (
                      <tr key={k}>
                        <td>{k}</td>
                        <td>{summary[k].numerator}</td>
                        <td>{summary[k].denominator}</td>
                        <td>
                          {summary[k].rate === null ? '—' : Math.round(summary[k].rate! * 100) + '%'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" onClick={exportReport}>
                  Export aggregate JSON
                </button>
                {summary.observing && <p>The 14-day observation window is still open.</p>}
                <h3>Model and search usage</h3>
                <ul>
                  {summary.usageCosts.map((x, i) => (
                    <li key={i}>
                      {x.provider} · {x.kind} · {x.requests} requests ·{' '}
                      {x.estimated_amount === null ? 'unpriced' : x.estimated_amount + ' ' + x.currency}{' '}
                      · {x.unpriced} without a price
                    </li>
                  ))}
                </ul>
                <h3>Daily activity</h3>
                <ul>
                  {summary.daily.map((row) => (
                    <li key={row.day + row.kind}>
                      {row.day} · {row.kind} · {row.count}
                    </li>
                  ))}
                </ul>
                <p>
                  Reply handling · P50{' '}
                  {summary.handlingSeconds.p50 === null
                    ? '—'
                    : Math.round(summary.handlingSeconds.p50) + ' s'}{' '}
                  · P90{' '}
                  {summary.handlingSeconds.p90 === null
                    ? '—'
                    : Math.round(summary.handlingSeconds.p90) + ' s'}{' '}
                  · Overdue {summary.handlingSeconds.overdue}
                </p>
                {operate && (
                  <>
                    <h3>Conversations behind the reply rate</h3>
                    {summary.cohort
                      .filter((c) => c.replied)
                      .map((c) => (
                        <details key={c.id}>
                          <summary>
                            {detail?.prospects.find((v) => v.id === c.id)?.displayName ?? c.id}
                            {c.interested ? ' · Interested' : ''}
                          </summary>
                          {c.first_reply_ids.map((id) => (
                            <p key={id}>{detail?.inbox.find((i) => i.id === id)?.text ?? id}</p>
                          ))}
                        </details>
                      ))}
                  </>
                )}
                <p>{summary.byState.map((s) => s.count + ' ' + s.status).join(' · ')}</p>
                <p>{summary.costs.map((c) => c.amount + ' ' + c.currency).join(' · ')}</p>
                <p>
                  {summary.timezone} · Updated {new Date(summary.watermark).toLocaleString()}
                </p>
              </section>
            )}
            {tab === 'Connections' && (
              <div className="workgrid">
                <section>
                  <h2>Member mailboxes</h2>
                  {operate && (
                    <>
                      <Form
                        label="Connect account"
                        run={async (d) => {
                          const x = await request<{ url: string }>('mailboxes/connect', d);
                          location.assign(x.url);
                        }}
                      >
                        <Select
                          name="provider"
                          label="Provider"
                          options={[
                            ['gmail', 'Gmail'],
                            ['feishu', 'Feishu'],
                            ['graph', 'Microsoft 365'],
                            ['nylas', 'Nylas hosted mailbox']
                          ]}
                        />
                      </Form>
                      <details>
                        <summary>SMTP or simulator</summary>
                        <Form label="Verify and connect" run={(d) => modify('mailboxes', d)}>
                          <Select
                            name="provider"
                            label="Transport"
                            options={[
                              ['simulated', 'Local simulator'],
                              ['smtp', 'SMTP and IMAP']
                            ]}
                          />
                          <Input name="address" label="Mailbox address" type="email" />
                          <Input name="smtpHost" label="SMTP host" optional />
                          <Input name="imapHost" label="IMAP host" optional />
                          <Input name="password" type="password" label="Application password" optional />
                        </Form>
                      </details>
                    </>
                  )}
                  {boxes.map((m) => (
                    <details key={m.id}>
                      <summary>
                        {m.address} · {m.active ? 'Connected' : 'Disconnected'}
                      </summary>
                      <p>
                        {m.provider} · Limit {m.cap}/day
                      </p>
                      {m.owner_id === me?.id && p && (
                        <>
                          <Form
                            label="Delegate to this campaign"
                            run={(d) =>
                              modify('mailboxes/' + m.id + '/grant', { campaignId: p.id, ...d })
                            }
                          >
                            <Input name="expiresAt" label="Grant expires" type="date" value={expiry()} />
                          </Form>
                          <Form
                            label="Revoke campaign access"
                            run={() =>
                              modify('mailboxes/' + m.id + '/grant', {
                                campaignId: p.id,
                                action: 'revoke'
                              })
                            }
                          >
                            <></>
                          </Form>
                          <Form
                            label="Disconnect mailbox"
                            run={() => modify('mailboxes/' + m.id + '/grant', { action: 'disconnect' })}
                          >
                            <></>
                          </Form>
                        </>
                      )}
                    </details>
                  ))}
                </section>
                {research && (
                  <section>
                    <h2>Model bindings</h2>
                    <Form label="Save model binding" run={(d) => modify('bindings', d)}>
                      <Select
                        name="provider"
                        label="Provider"
                        options={['openai', 'anthropic', 'gemini', 'local-artifact'].map((v) => [v, v])}
                      />
                      <Input name="model" label="Model ID or local skill name" />
                      <Input name="key" label="API key (API models)" type="password" optional />
                    </Form>
                    {bindings
                      .filter((b) => b.active)
                      .map((b) => (
                        <Form
                          key={b.id}
                          label="Revoke binding"
                          run={() => modify('bindings/' + b.id, undefined, 'DELETE')}
                        >
                          <span>
                            {b.provider} · {b.model}
                          </span>
                        </Form>
                      ))}
                  </section>
                )}
                {me?.role === 'admin' && (
                  <section>
                    <h2>Members</h2>
                    <Form
                      label="Invite member"
                      run={async (d) => {
                        const r = await request<{ token: string }>('members', d);
                        setInvitation(location.origin + '/workspace#token=' + r.token);
                        refresh();
                      }}
                    >
                      <Input name="name" label="Member name" />
                      <Select
                        name="role"
                        label="Role"
                        options={['operator', 'reviewer', 'researcher', 'analyst', 'viewer'].map((r) => [
                          r,
                          r
                        ])}
                      />
                    </Form>
                    {invitation && (
                      <label>
                        Private invitation link
                        <input readOnly value={invitation} />
                      </label>
                    )}
                    {members
                      .filter((m) => m.role !== 'admin')
                      .map((m) => (
                        <Form
                          key={m.id}
                          label="Remove member"
                          run={() => modify('members/' + m.id, undefined, 'DELETE')}
                        >
                          <span>
                            {m.name} · {m.role}
                          </span>
                        </Form>
                      ))}
                  </section>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
