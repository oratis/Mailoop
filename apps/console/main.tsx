import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { MailoopClient } from '../../packages/client.ts';
import type { Member } from '../../packages/db/database.ts';
import type { Campaign, CampaignEvent } from '../../packages/domain/campaigns.ts';
import './style.css';

const incoming = new URLSearchParams(location.hash.slice(1)).get('token');
if (incoming) {
  sessionStorage.setItem('mailoop-token', incoming);
  history.replaceState(null, '', location.pathname);
}
const token = sessionStorage.getItem('mailoop-token');
const api = new MailoopClient(location.origin, token ?? '');
const labels: Record<string, string> = {
  draft: 'Needs review', scheduled: 'Scheduled', submitting: 'Submitting', unknown: 'Reconciling', accepted: 'Accepted', replied: 'Replied'
};
function Status({ stage }: { stage: string }) {
  return <span className={'status ' + stage}>{labels[stage] ?? stage}</span>;
}

function CampaignDetail({ campaign, reviewer, onApprove, busy, refresh }: {
  campaign: Campaign; reviewer: boolean; onApprove: () => void; busy: boolean; refresh: number;
}) {
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.events(campaign.id).then(rows => { if (active) { setEvents(rows); setError(''); } })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [campaign.id, campaign.stage, refresh]);
  const draft = campaign.draft;
  return <article className="detail">
    <header className="detail-heading"><div><p className="eyebrow">Campaign</p><h2>{campaign.name}</h2></div><Status stage={campaign.stage}/></header>
    <p className="brief">{campaign.brief}</p>
    <section><h3>Research evidence</h3>
      <ul className="shortlist">{draft.research.map(row => <li key={row.creator}>{row.creator} · {row.status.replaceAll('_', ' ')}</li>)}</ul>
      <strong>{draft.creator}</strong><p lang="ja">{draft.evidence}</p>
      <dl><dt>Evidence page</dt><dd>{draft.source}</dd><dt>Recent work</dt><dd>{draft.work}</dd>
        <dt>Contact permission</dt><dd>{draft.permission.grantedBy} · {draft.permission.purpose}</dd></dl>
    </section>
    <section><h3>Message review</h3>
      <dl><dt>From</dt><dd>{draft.from}</dd><dt>To</dt><dd>{draft.to}</dd></dl>
      <div className="letter" lang="ja"><strong>{draft.subject}</strong><p>{draft.body}</p></div>
      {reviewer && campaign.stage === 'draft' && <button disabled={busy} onClick={onApprove}>Approve simulated send</button>}
    </section>
    {campaign.reply && <section><h3>Inbox reply</h3><p className="reply" lang="ja">{campaign.reply}</p></section>}
    <section><h3>Activity</h3>{error && <p role="alert">{error}</p>}
      <ol className="timeline">{events.map(event => <li key={event.sequence}>
        <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        <span>{event.detail}</span></li>)}</ol>
    </section>
  </article>;
}

function App() {
  const [member, setMember] = useState<Member>();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, select] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, reload] = useState(0);
  useEffect(() => {
    if (!token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [me, rows] = await Promise.all([api.me(), api.campaigns()]);
        if (active) { setMember(me); setCampaigns(rows); setPollError(''); }
      } catch (e) { if (active) setPollError((e as Error).message); }
      if (active) timer = setTimeout(poll, 1200);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);
  const campaign = campaigns.find(c => c.id === selected) ?? campaigns[0];
  async function change(action: () => Promise<Campaign>) {
    setBusy(true); setError('');
    try {
      const updated = await action();
      setCampaigns(prev => [updated, ...prev.filter(c => c.id !== updated.id)]);
      select(updated.id); reload(n => n + 1); return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (await change(() => api.create(name))) setName('');
  }
  return <>
    <header className="top"><span className="wordmark">Mailoop</span><span>Local simulator</span></header>
    <main><header className="page-heading"><div><p className="eyebrow">{member?.workspaceName ?? 'Workspace'}</p><h1>Campaigns</h1></div>
      {member && <span className="member">{member.name}</span>}</header>
    {(error || pollError) && <p role="alert">{error || pollError}</p>}
    {!token ? <p>Open a workspace link printed by <code>npm run demo</code> to view its campaigns.</p> :
      !member ? <p>Connecting to the workspace…</p> :
      <div className="layout"><aside><h2>Activity queue</h2>
        {member.role === 'reviewer' && <form onSubmit={create}><label htmlFor="name">New sample campaign</label>
          <div className="create"><input id="name" placeholder="Campaign name" value={name} maxLength={100} required
            onChange={e => setName(e.target.value)}/><button disabled={busy || !name.trim()}>Create</button></div></form>}
        <nav aria-label="Campaigns">{campaigns.map(c => <button className="campaign-row" key={c.id} aria-current={c.id === campaign?.id}
          onClick={() => select(c.id)}><span>{c.name}</span><Status stage={c.stage}/></button>)}</nav>
      </aside>{campaign ? <CampaignDetail key={campaign.id} campaign={campaign} reviewer={member.role === 'reviewer'}
        refresh={refresh} busy={busy} onApprove={() => void change(() => api.approve(campaign.id, campaign.revision))}/> :
        <article className="detail"><h2>No campaigns yet</h2><p>Create a sample campaign to review its research and first message.</p></article>}</div>}
    </main></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
