CREATE TABLE "user_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"user_auth_version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	CONSTRAINT "user_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "user_rate_limit_per_minute" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "user_max_concurrent" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "access_auth_mode" text DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_api_keys_user" ON "user_api_keys" USING btree ("user_id");