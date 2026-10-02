-- Legacy credentials identify users only by a reusable username. They cannot
-- safely be backfilled after historical account deletion/recreation.
DELETE FROM "auth_codes";--> statement-breakpoint
DELETE FROM "login_sessions";--> statement-breakpoint
DELETE FROM "refresh_tokens";--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN "user_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN "user_auth_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD COLUMN "user_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD COLUMN "user_auth_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_connection_states" ADD COLUMN "auth_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "user_id" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "user_auth_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD CONSTRAINT "auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD CONSTRAINT "login_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
