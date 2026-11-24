SET LOCAL search_path = mailoop, pg_catalog;

CREATE FUNCTION authenticate_member(digest text)
RETURNS TABLE (id uuid, name text, role text, "workspaceId" uuid, "workspaceName" text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog,mailoop AS $$
  SELECT m.id,m.name,m.role,w.id,w.name FROM members m JOIN workspaces w ON w.id=m.workspace_id
  WHERE m.token_hash=digest AND m.active FOR SHARE OF m
$$;
REVOKE ALL ON FUNCTION authenticate_member(text) FROM PUBLIC;

ALTER TABLE letters ADD COLUMN checked_at timestamptz;
ALTER TABLE inbound ADD COLUMN handler_id uuid, ADD FOREIGN KEY (workspace_id,handler_id) REFERENCES members;
ALTER TABLE prospects ADD COLUMN shortlisted boolean NOT NULL DEFAULT true;
CREATE INDEX inbound_letter_time ON inbound(workspace_id,letter_id,received_at);
CREATE INDEX letters_prospect_time ON letters(workspace_id,prospect_id,accepted_at);
CREATE INDEX prospects_campaign ON prospects(workspace_id,program_id);
CREATE INDEX imports_created ON imports(workspace_id,created_at);
CREATE INDEX accepted_queue ON letters(workspace_id,due_at) WHERE status='accepted';
ALTER TABLE letters ADD COLUMN template_version text NOT NULL DEFAULT 'manual';
