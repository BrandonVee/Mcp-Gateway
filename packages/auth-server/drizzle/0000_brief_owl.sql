CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TABLE "auth_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text,
	"sub" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_name" text,
	"redirect_uris" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"sub" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"name" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"sub" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"expires_at" bigint NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_server_access" (
	"user_id" bigint NOT NULL,
	"server_name" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "user_server_access_user_id_server_name_pk" PRIMARY KEY("user_id","server_name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "user_server_access" ADD CONSTRAINT "user_server_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_server_access" ADD CONSTRAINT "user_server_access_server_name_mcp_servers_name_fk" FOREIGN KEY ("server_name") REFERENCES "public"."mcp_servers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_codes_expiry" ON "auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_refresh_expiry" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_user_server_name" ON "user_server_access" USING btree ("server_name");