SET LOCAL search_path=mailoop,pg_catalog;
ALTER TABLE letters ADD COLUMN approved_mime text, ADD COLUMN approved_digest text;
UPDATE letters SET status='held',reason='review_final_content' WHERE status='scheduled';
CREATE TABLE draft_history (
 workspace_id uuid NOT NULL, letter_id uuid NOT NULL, revision uuid NOT NULL,
 sealed text NOT NULL, superseded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id,letter_id,revision), FOREIGN KEY (workspace_id,letter_id) REFERENCES letters
);
ALTER TABLE draft_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON draft_history USING (workspace_id=nullif(current_setting('mailoop.workspace',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON draft_history TO mailoop_demo_runtime;

CREATE TABLE workspace_policies (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces, retention_days int CHECK(retention_days BETWEEN 1 AND 3650),
 last_cleanup timestamptz
);
ALTER TABLE workspace_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON workspace_policies USING (workspace_id=nullif(current_setting('mailoop.workspace',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON workspace_policies TO mailoop_demo_runtime;
ALTER TABLE prospects ADD COLUMN erased_at timestamptz;
ALTER TABLE inbound ADD COLUMN redacted boolean NOT NULL DEFAULT false;
ALTER TABLE mailboxes ADD COLUMN sync_lease uuid, ADD COLUMN sync_error text;
CREATE TABLE other_channels (
 workspace_id uuid NOT NULL,program_id uuid NOT NULL,channel_key text NOT NULL,prospect_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,program_id,channel_key),FOREIGN KEY(workspace_id,prospect_id) REFERENCES prospects,
 FOREIGN KEY(workspace_id,program_id) REFERENCES programs
);
ALTER TABLE other_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON other_channels USING (workspace_id=nullif(current_setting('mailoop.workspace',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON other_channels TO mailoop_demo_runtime;
CREATE OR REPLACE FUNCTION remove_member(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mailoop AS $$
DECLARE ws uuid := current_setting('mailoop.workspace')::uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=ws AND id=current_setting('mailoop.member')::uuid AND active AND role='admin') THEN RAISE EXCEPTION 'Workspace admin required'; END IF;
 UPDATE members SET active=false WHERE workspace_id=ws AND id=target AND role<>'admin' AND active;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE mailboxes SET active=false,version=version+1,secret='' WHERE workspace_id=ws AND owner_id=target;
 DELETE FROM delegations d USING mailboxes m WHERE d.workspace_id=ws AND m.workspace_id=ws AND d.mailbox_id=m.id AND m.owner_id=target;
 UPDATE bindings SET active=false,secret='' WHERE workspace_id=ws AND owner_id=target;
 DELETE FROM oauth_states WHERE workspace_id=ws AND owner_id=target;
 UPDATE runs SET status='cancelled',checkpoint=NULL,lease_id=NULL WHERE workspace_id=ws AND owner_id=target AND status NOT IN ('cancelled','completed');
END $$;
ALTER TABLE inbound ADD COLUMN assignee_id uuid, ADD FOREIGN KEY (workspace_id,assignee_id) REFERENCES members;
ALTER TABLE bindings ADD COLUMN rates jsonb;
CREATE TABLE usage_facts (
 workspace_id uuid NOT NULL, program_id uuid NOT NULL, id uuid NOT NULL, run_id uuid, kind text NOT NULL, provider text NOT NULL,
 rates jsonb, units jsonb, amount numeric, currency text, at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,program_id) REFERENCES programs, FOREIGN KEY(workspace_id,run_id) REFERENCES runs
);
ALTER TABLE usage_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON usage_facts USING (workspace_id=nullif(current_setting('mailoop.workspace',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON usage_facts TO mailoop_demo_runtime;
ALTER TABLE prospects ADD COLUMN evidence_until timestamptz;
UPDATE prospects SET evidence_ok=false WHERE evidence_ok;
