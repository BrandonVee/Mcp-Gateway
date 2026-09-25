ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_auth_method" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
UPDATE "mcp_servers" SET "oauth_client_auth_method" = 'client_secret_basic' WHERE "auth_mode" = 'oauth' AND "oauth_client_secret" IS NOT NULL;
