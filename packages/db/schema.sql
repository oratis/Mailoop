CREATE SCHEMA mailoop;
SET LOCAL search_path = mailoop, pg_catalog;
CREATE ROLE mailoop_demo_runtime NOLOGIN NOBYPASSRLS;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
CREATE TABLE members (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('reviewer', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE campaigns (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  brief text NOT NULL,
  draft jsonb NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  event_number integer NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, id, revision),
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE dispatches (
  workspace_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  approved_by uuid NOT NULL,
  revision uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('scheduled','submitting','unknown','accepted')),
  due_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  receipt_id uuid,
  reply text,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, campaign_id),
  FOREIGN KEY (workspace_id, approved_by) REFERENCES members,
  FOREIGN KEY (workspace_id, campaign_id, revision) REFERENCES campaigns (workspace_id, id, revision)
);
CREATE TABLE events (
  workspace_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  sequence integer NOT NULL,
  type text NOT NULL,
  detail text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, campaign_id, sequence),
  FOREIGN KEY (workspace_id, campaign_id) REFERENCES campaigns
);
-- This table represents the simulated provider's independent durable mailbox.
CREATE TABLE simulated_receipts (
  workspace_id uuid NOT NULL,
  dispatch_id uuid NOT NULL,
  receipt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  reply text NOT NULL,
  PRIMARY KEY (workspace_id, dispatch_id)
);

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['campaigns','dispatches','events','simulated_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format(
      'CREATE POLICY tenant ON %I USING (workspace_id = nullif(current_setting(''mailoop.workspace'', true), '''')::uuid)',
      relation
    );
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA mailoop TO mailoop_demo_runtime;
GRANT SELECT, INSERT, UPDATE ON campaigns, dispatches TO mailoop_demo_runtime;
GRANT SELECT, INSERT ON events, simulated_receipts TO mailoop_demo_runtime;
