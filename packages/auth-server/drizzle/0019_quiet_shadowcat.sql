CREATE TABLE "upstream_credentials" (
	"instance_id" text NOT NULL,
	"owner" text NOT NULL,
	"user_id" bigint,
	"mode" text NOT NULL,
	"secret" text NOT NULL,
	"refresh_secret" text,
	"expires_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "upstream_credentials_instance_id_owner_pk" PRIMARY KEY("instance_id","owner")
);
--> statement-breakpoint
CREATE TABLE "upstream_oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"verifier" text NOT NULL,
	"auth_revision" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "display_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "auth_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "auth_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "api_key_header" text DEFAULT 'authorization' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "api_key_prefix" text DEFAULT 'Bearer ' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "system_api_key" text;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "oauth_authorize_url" text;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "oauth_token_url" text;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "oauth_client_secret" text;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "oauth_scopes" text;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "oauth_resource" text;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "oauth_issuer" text;--> statement-breakpoint
ALTER TABLE "mcp_server_instances" ADD COLUMN "oauth_client_auth_method" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_credentials" ADD CONSTRAINT "upstream_credentials_instance_id_mcp_server_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."mcp_server_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_credentials" ADD CONSTRAINT "upstream_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_oauth_states" ADD CONSTRAINT "upstream_oauth_states_instance_id_mcp_server_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."mcp_server_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_oauth_states" ADD CONSTRAINT "upstream_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_upstream_oauth_state_expiry" ON "upstream_oauth_states" USING btree ("expires_at");
--> statement-breakpoint
UPDATE mcp_server_instances i SET auth_mode = s.auth_mode, auth_revision = s.auth_revision, api_key_header = s.api_key_header, api_key_prefix = s.api_key_prefix, system_api_key = s.system_api_key, oauth_authorize_url = s.oauth_authorize_url, oauth_token_url = s.oauth_token_url, oauth_client_id = s.oauth_client_id, oauth_client_secret = s.oauth_client_secret, oauth_scopes = s.oauth_scopes, oauth_resource = s.oauth_resource, oauth_issuer = s.oauth_issuer, oauth_client_auth_method = s.oauth_client_auth_method, display_name = i.id FROM mcp_servers s WHERE s.name = i.server_name;
--> statement-breakpoint
INSERT INTO upstream_credentials (instance_id, owner, user_id, mode, secret, refresh_secret, expires_at, updated_at) SELECT i.id, concat('user:', c.user_id), c.user_id, c.mode, c.secret, c.refresh_secret, c.expires_at, c.updated_at FROM user_mcp_credentials c JOIN mcp_server_instances i ON i.server_name = c.server_name;
