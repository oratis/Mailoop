SET LOCAL search_path = mailoop, pg_catalog;
ALTER TABLE members DROP CONSTRAINT members_role_check;
ALTER TABLE members ADD CHECK (role IN ('admin','operator','reviewer','researcher','analyst','viewer'));
CREATE TABLE programs (
 workspace_id uuid NOT NULL REFERENCES workspaces, id uuid NOT NULL DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
 name text NOT NULL, brief text NOT NULL, facts jsonb NOT NULL, purpose text NOT NULL, region text NOT NULL,
 timezone text NOT NULL, window_start int NOT NULL, window_end int NOT NULL, cap int NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')), version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES members
);
CREATE TABLE program_members (
 workspace_id uuid NOT NULL, program_id uuid NOT NULL, member_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,program_id,member_id), FOREIGN KEY(workspace_id,program_id) REFERENCES programs,
 FOREIGN KEY(workspace_id,member_id) REFERENCES members
);
CREATE TABLE imports (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), program_id uuid NOT NULL, run_key text NOT NULL,
 digest text NOT NULL, sealed text NOT NULL, decisions jsonb NOT NULL, applied_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,run_key), FOREIGN KEY(workspace_id,program_id) REFERENCES programs
);
CREATE TABLE prospects (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), program_id uuid NOT NULL, channel_key text NOT NULL,
 contact_key text, sealed text NOT NULL, evidence_ok boolean NOT NULL DEFAULT false, stage text NOT NULL DEFAULT 'shortlisted',
 verified_by uuid, PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,program_id,channel_key),
 FOREIGN KEY(workspace_id,program_id) REFERENCES programs, FOREIGN KEY(workspace_id,verified_by) REFERENCES members
);
CREATE INDEX prospect_contacts ON prospects(workspace_id, contact_key);
CREATE TABLE consents (
 workspace_id uuid NOT NULL, contact_key text NOT NULL, purpose text NOT NULL, region text NOT NULL, sealed text NOT NULL,
 expires_at timestamptz NOT NULL, actor_id uuid NOT NULL, PRIMARY KEY(workspace_id,contact_key,purpose,region),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES members
);
CREATE TABLE suppressions (
 workspace_id uuid NOT NULL REFERENCES workspaces, contact_key text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,contact_key)
);
CREATE TABLE bindings (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
 provider text NOT NULL, model text NOT NULL, secret text NOT NULL, active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES members
);
CREATE TABLE runs (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), program_id uuid NOT NULL, owner_id uuid NOT NULL,
 binding_id uuid, request_key text NOT NULL, fingerprint text NOT NULL, config jsonb NOT NULL, checkpoint text,
 status text NOT NULL DEFAULT 'queued', step text NOT NULL DEFAULT 'search', calls int NOT NULL DEFAULT 0, budget int NOT NULL,
 lease_id uuid, due_at timestamptz NOT NULL DEFAULT now(), note text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,request_key), FOREIGN KEY(workspace_id,program_id) REFERENCES programs,
 FOREIGN KEY(workspace_id,owner_id) REFERENCES members, FOREIGN KEY(workspace_id,binding_id) REFERENCES bindings
);
CREATE TABLE oauth_states (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, provider text NOT NULL,
 secret text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,owner_id) REFERENCES members
);
CREATE TABLE mailboxes (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, provider text NOT NULL,
 account_key text NOT NULL, address text NOT NULL, secret text NOT NULL, cap int NOT NULL, version int NOT NULL DEFAULT 1,
 active boolean NOT NULL DEFAULT true, cursor text, synced_at timestamptz, next_sync timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,provider,account_key), FOREIGN KEY(workspace_id,owner_id) REFERENCES members
);
CREATE TABLE delegations (
 workspace_id uuid NOT NULL, mailbox_id uuid NOT NULL, program_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,mailbox_id,program_id), FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes, FOREIGN KEY(workspace_id,program_id) REFERENCES programs
);
CREATE TABLE letters (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), prospect_id uuid NOT NULL, mailbox_id uuid NOT NULL,
 step text NOT NULL CHECK(step IN ('first','followup','reply')), parent_id uuid, sealed text NOT NULL,
 revision uuid NOT NULL DEFAULT gen_random_uuid(), approved_by uuid, program_version int, mailbox_version int,
 status text NOT NULL DEFAULT 'draft', due_at timestamptz NOT NULL DEFAULT now(), lease_id uuid, attempted_at timestamptz,
 accepted_at timestamptz, receipt text, reason text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,prospect_id) REFERENCES prospects,
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes, FOREIGN KEY(workspace_id,approved_by) REFERENCES members,
 FOREIGN KEY(workspace_id,parent_id) REFERENCES letters
);
CREATE UNIQUE INDEX sequence_step ON letters(workspace_id,prospect_id,step) WHERE step IN ('first','followup') AND status <> 'cancelled';
CREATE INDEX letter_queue ON letters(workspace_id,due_at) WHERE status IN ('scheduled','submitting','unknown');
CREATE TABLE inbound (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), mailbox_id uuid NOT NULL, source_id text NOT NULL,
 letter_id uuid, kind text NOT NULL, sealed text NOT NULL, handled_at timestamptz, received_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,mailbox_id,source_id), FOREIGN KEY(workspace_id,letter_id) REFERENCES letters,
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes
);
CREATE TABLE outcomes (
 workspace_id uuid NOT NULL, source text NOT NULL, external_id text NOT NULL, prospect_id uuid NOT NULL, kind text NOT NULL,
 amount numeric, currency text, occurred_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,source,external_id), FOREIGN KEY(workspace_id,prospect_id) REFERENCES prospects
);
CREATE TABLE journal (
 workspace_id uuid NOT NULL, program_id uuid NOT NULL, seq bigint NOT NULL, type text NOT NULL,
 resource_id uuid NOT NULL, actor_id uuid, detail jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,program_id,seq), FOREIGN KEY(workspace_id,program_id) REFERENCES programs
);
DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['programs','program_members','imports','prospects','consents','suppressions','bindings','runs','oauth_states','mailboxes','delegations','letters','inbound','outcomes','journal'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
  EXECUTE format('CREATE POLICY tenant ON %I USING (workspace_id = nullif(current_setting(''mailoop.workspace'',true),'''')::uuid)', relation);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO mailoop_demo_runtime',relation);
 END LOOP;
END $$;
CREATE VIEW active_members WITH (security_barrier=true) AS
 SELECT id,name,role,workspace_id FROM members WHERE active AND workspace_id=nullif(current_setting('mailoop.workspace',true),'')::uuid;
GRANT SELECT ON active_members TO mailoop_demo_runtime;
CREATE FUNCTION invite_member(label text, member_role text, digest text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,mailoop AS $$
DECLARE ws uuid := current_setting('mailoop.workspace')::uuid; created uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=ws AND id=current_setting('mailoop.member')::uuid AND active AND role='admin')
 OR member_role NOT IN ('reviewer','operator','researcher','analyst','viewer') THEN RAISE EXCEPTION 'Workspace admin required'; END IF;
 INSERT INTO members(workspace_id,name,role,token_hash) VALUES(ws,label,member_role,digest) RETURNING id INTO created;
 RETURN created;
END $$;
CREATE FUNCTION remove_member(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,mailoop AS $$
DECLARE ws uuid := current_setting('mailoop.workspace')::uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=ws AND id=current_setting('mailoop.member')::uuid AND active AND role='admin') THEN RAISE EXCEPTION 'Workspace admin required'; END IF;
 UPDATE members SET active=false WHERE workspace_id=ws AND id=target AND role<>'admin';
 UPDATE mailboxes SET active=false,version=version+1,secret='' WHERE workspace_id=ws AND owner_id=target AND NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=ws AND id=target AND active);
END $$;
REVOKE ALL ON FUNCTION invite_member(text,text,text), remove_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_member(text,text,text), remove_member(uuid) TO mailoop_demo_runtime;
