CREATE TABLE "signup_email_codes" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_signup_email_codes_expiry" ON "signup_email_codes" USING btree ("expires_at");