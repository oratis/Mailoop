import { RequestError } from '../db/database.ts';
import { type Context, type Input, program, record, requireRole } from './context.ts';
import { field, id, instant } from './security.ts';
import { prospect } from './imports.ts';

export async function outcome(ctx: Context, prospectId: string, b: Input) {
  requireRole(ctx, 'operator', 'reviewer');
  const r = await prospect(ctx, prospectId),
    source = field(b.source, 'source', 80),
    external = field(b.externalId, 'external id', 200);
  const kind = field(b.kind, 'kind');
  if (!['won', 'published', 'conversion', 'cost'].includes(kind))
    throw new RequestError(422, 'Invalid outcome.');
  const amount = b.amount === undefined ? null : Number(b.amount),
    currency = b.currency === undefined ? null : field(b.currency, 'currency', 3).toUpperCase();
  if (
    (amount === null) !== (currency === null) ||
    (amount !== null && (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency!)))
  )
    throw new RequestError(422, 'Provide a nonnegative amount and ISO currency together.');
  const at = instant(b.occurredAt);
  const { rowCount } = await ctx.db.query(
    `INSERT INTO outcomes(workspace_id,source,external_id,prospect_id,kind,amount,currency,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [ctx.member.workspaceId, source, external, r.id, kind, amount, currency, at]
  );
  if (!rowCount) {
    const { rowCount: same } = await ctx.db.query(
      `SELECT 1 FROM outcomes WHERE source=$1 AND external_id=$2 AND prospect_id=$3 AND kind=$4
      AND amount IS NOT DISTINCT FROM $5::numeric AND currency IS NOT DISTINCT FROM $6::text AND occurred_at=$7`,
      [source, external, r.id, kind, amount, currency, at]
    );
    if (!same) throw new RequestError(409, 'Conflicting external event.');
    return { duplicate: true };
  }
  if (kind === 'won') await ctx.db.query("UPDATE prospects SET stage='won' WHERE id=$1", [r.id]);
  await record(ctx.db, ctx.member.workspaceId, r.program_id, 'outcome.' + kind, r.id, ctx.member.id);
  return { accepted: true };
}
export async function report(
  ctx: Context,
  campaign: string,
  from: string | null,
  to: string | null,
  filters = new URLSearchParams()
) {
  const p = await program(ctx, campaign);
  async function boundary(value: string | null, fallback: Date) {
    if (!value) return fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return instant(value);
    const d = instant(value);
    if (d.toISOString().slice(0, 10) !== value) throw new RequestError(422, 'Invalid calendar date.');
    return (await ctx.db.query('SELECT $1::date::timestamp AT TIME ZONE $2 AS at', [value, p.timezone]))
      .rows[0].at as Date;
  }
  const start = await boundary(from, new Date(0)),
    end = await boundary(to, new Date());
  if (start > end) throw new RequestError(422, 'Invalid reporting period.');
  const optionalId = (key: string) =>
    filters.has(key) && filters.get(key) ? id(filters.get(key)) : null;
  const mailbox = optionalId('mailbox'),
    owner = optionalId('owner'),
    template = filters.get('template') || null,
    region = filters.get('region') || null;
  const scope = ` WITH visible_letters AS (SELECT l.* FROM letters l JOIN prospects p ON p.id=l.prospect_id JOIN programs c ON c.id=p.program_id JOIN mailboxes m ON m.id=l.mailbox_id
    WHERE c.id=$1 AND ($4::uuid IS NULL OR m.id=$4) AND ($5::uuid IS NULL OR m.owner_id=$5) AND ($6::text IS NULL OR l.template_version=$6) AND ($7::text IS NULL OR c.region=$7)),
    period AS (SELECT $2::timestamptz AS since,$3::timestamptz AS until) `;
  const params = [campaign, start, end, mailbox, owner, template, region];
  const { rows: cohort } = await ctx.db.query(
    scope +
      `SELECT p.id,p.stage,l.accepted_at,l.mailbox_id,p.contact_key,
    ARRAY(SELECT i.id FROM inbound i JOIN letters x ON x.id=i.letter_id WHERE x.prospect_id=p.id AND i.kind NOT IN ('auto_reply','hard_bounce','soft_bounce','complaint') AND i.received_at BETWEEN l.accepted_at AND l.accepted_at+interval '14 days' ORDER BY i.received_at LIMIT 1) AS first_reply_ids,
    EXISTS(SELECT 1 FROM inbound i JOIN letters x ON x.id=i.letter_id WHERE x.prospect_id=p.id AND i.kind NOT IN ('auto_reply','hard_bounce','soft_bounce','complaint') AND i.received_at BETWEEN l.accepted_at AND l.accepted_at+interval '14 days') AS replied,
    EXISTS(SELECT 1 FROM inbound i JOIN letters x ON x.id=i.letter_id WHERE x.prospect_id=p.id AND i.kind IN ('interested','quote') AND i.received_at BETWEEN l.accepted_at AND l.accepted_at+interval '14 days') AS interested,
    EXISTS(SELECT 1 FROM outcomes o WHERE o.prospect_id=p.id AND kind='won' AND o.occurred_at BETWEEN l.accepted_at AND l.accepted_at+interval '14 days') AS won,
    EXISTS(SELECT 1 FROM suppressions s WHERE s.contact_key=p.contact_key AND s.created_at BETWEEN l.accepted_at AND l.accepted_at+interval '14 days' AND s.reason IN ('opt_out','unsubscribe')) AS opted_out
    FROM prospects p JOIN visible_letters l ON l.prospect_id=p.id AND l.step='first' AND l.status='accepted'
    WHERE p.program_id=$1 AND l.accepted_at >=$2 AND l.accepted_at<$3 ORDER BY l.accepted_at`,
    params
  );
  const byState = (
    await ctx.db.query(
      scope +
        `SELECT l.status,count(*)::int AS count FROM visible_letters l JOIN prospects p ON p.id=l.prospect_id WHERE p.program_id=$1 AND l.created_at>=$2 AND l.created_at<$3 GROUP BY l.status`,
      params
    )
  ).rows;
  const costs = (
    await ctx.db.query(
      scope +
        `SELECT currency,sum(amount)::text AS amount FROM outcomes o JOIN prospects p ON p.id=o.prospect_id WHERE p.program_id=$1 AND o.kind='cost' AND occurred_at>=$2 AND occurred_at<$3 AND ($7::text IS NULL OR EXISTS (SELECT 1 FROM programs c WHERE c.id=$1 AND c.region=$7))
    AND (($4::uuid IS NULL AND $5::uuid IS NULL AND $6::text IS NULL) OR EXISTS(SELECT 1 FROM visible_letters l WHERE l.prospect_id=p.id)) GROUP BY currency`,
      params
    )
  ).rows;
  const usageCosts =
    !owner && !mailbox && !template && (!region || region === p.region)
      ? (
          await ctx.db.query(
            `SELECT kind,provider,currency,count(*)::int AS requests,count(*) FILTER(WHERE amount IS NULL)::int AS unpriced,sum(amount)::text AS estimated_amount FROM usage_facts WHERE program_id=$1 AND at >= $2 AND at<$3 GROUP BY kind,provider,currency ORDER BY kind,provider,currency`,
            [campaign, start, end]
          )
        ).rows
      : [];
  const rate = (n: number, d = cohort.length) => ({
    numerator: n,
    denominator: d,
    rate: d ? n / d : null
  });
  const delivery = (
    await ctx.db.query(
      scope +
        `SELECT l.id,EXISTS(SELECT 1 FROM inbound i WHERE i.letter_id=l.id AND i.kind='hard_bounce' AND i.received_at BETWEEN l.accepted_at AND l.accepted_at+interval '14 days') AS bounced
    FROM visible_letters l JOIN prospects p ON p.id=l.prospect_id WHERE p.program_id=$1 AND l.status='accepted' AND l.accepted_at>=$2 AND l.accepted_at<$3`,
      params
    )
  ).rows;
  const daily = (
    await ctx.db.query(
      scope +
        `SELECT to_char(moment AT TIME ZONE $8,'YYYY-MM-DD') AS day,kind,count(*)::int AS count FROM
    (SELECT accepted_at AS moment,'accepted' AS kind FROM visible_letters WHERE accepted_at IS NOT NULL UNION ALL SELECT i.received_at,i.kind FROM inbound i JOIN visible_letters l ON l.id=i.letter_id) activity
    WHERE moment>=$2 AND moment<$3 GROUP BY day,kind ORDER BY day,kind`,
      [...params, p.timezone]
    )
  ).rows;
  const handling = (
    await ctx.db.query(
      scope +
        `SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM i.handled_at-i.received_at)) AS p50,
    percentile_cont(0.9) WITHIN GROUP(ORDER BY extract(epoch FROM i.handled_at-i.received_at)) AS p90,
    max(extract(epoch FROM now()-i.received_at)) FILTER(WHERE i.handled_at IS NULL) AS longest_pending,
    count(*) FILTER(WHERE i.handled_at IS NULL AND i.received_at<now()-interval '24 hours')::int AS overdue
    FROM inbound i JOIN visible_letters l ON l.id=i.letter_id WHERE i.kind NOT IN ('auto_reply','hard_bounce','soft_bounce','complaint') AND i.received_at>=$2 AND i.received_at<$3`,
      params
    )
  ).rows[0];
  const audience = (
    await ctx.db.query(
      scope +
        `SELECT count(*)::int AS assessed,count(*) FILTER(WHERE p.shortlisted)::int AS shortlisted,
    count(*) FILTER(WHERE p.shortlisted AND p.evidence_ok AND p.evidence_until>now() AND EXISTS(SELECT 1 FROM consents k WHERE k.contact_key=p.contact_key AND k.region=c.region AND k.purpose=c.purpose AND k.expires_at>now())
    AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.contact_key=p.contact_key))::int AS eligible
    FROM prospects p JOIN programs c ON c.id=p.program_id WHERE c.id=$1 AND ($7::text IS NULL OR c.region=$7)
    AND (($4::uuid IS NULL AND $5::uuid IS NULL AND $6::text IS NULL) OR EXISTS(SELECT 1 FROM visible_letters l WHERE l.prospect_id=p.id))`,
      params
    )
  ).rows[0];
  const wins = cohort.filter((x) => x.won).length;
  const aggregateOnly = ['viewer', 'analyst'].includes(ctx.member.role);
  return {
    usageCosts,
    daily,
    handlingSeconds: handling,
    shortlist: rate(audience.shortlisted, audience.assessed),
    contactable: rate(audience.eligible, audience.shortlisted),
    costPerWin: costs.map((c) => ({ ...c, perWon: wins ? Number(c.amount) / wins : null })),
    timezone: p.timezone,
    windowDays: 14,
    from: start,
    to: end,
    watermark: new Date(),
    observing: cohort.some((x) => Date.now() - x.accepted_at.getTime() < 14 * 86400000),
    byState,
    costs,
    reply: rate(cohort.filter((x) => x.replied).length),
    interest: rate(cohort.filter((x) => x.interested).length),
    won: rate(cohort.filter((x) => x.won).length),
    hardBounce: rate(delivery.filter((x) => x.bounced).length, delivery.length),
    unsubscribe: rate(
      new Set(cohort.filter((x) => x.opted_out).map((x) => x.contact_key)).size,
      new Set(cohort.map((x) => x.contact_key)).size
    ),
    cohort: aggregateOnly ? [] : cohort.map(({ contact_key, ...row }) => row)
  };
}
