CREATE TABLE "oauth_connection_states" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"server_name" text NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mcp_credentials" (
	"user_id" bigint NOT NULL,
	"server_name" text NOT NULL,
	"mode" text NOT NULL,
	"secret" text NOT NULL,
	"refresh_secret" text,
	"expires_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "user_mcp_credentials_user_id_server_name_pk" PRIMARY KEY("user_id","server_name")
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "api_key_header" text DEFAULT 'authorization' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "api_key_prefix" text DEFAULT 'Bearer ' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_authorize_url" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_token_url" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_secret" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_scopes" text;--> statement-breakpoint
ALTER TABLE "oauth_connection_states" ADD CONSTRAINT "oauth_connection_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connection_states" ADD CONSTRAINT "oauth_connection_states_server_name_mcp_servers_name_fk" FOREIGN KEY ("server_name") REFERENCES "public"."mcp_servers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mcp_credentials" ADD CONSTRAINT "user_mcp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mcp_credentials" ADD CONSTRAINT "user_mcp_credentials_server_name_mcp_servers_name_fk" FOREIGN KEY ("server_name") REFERENCES "public"."mcp_servers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_connection_state_expiry" ON "oauth_connection_states" USING btree ("expires_at");