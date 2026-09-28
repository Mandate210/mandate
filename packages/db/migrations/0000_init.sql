CREATE TYPE "public"."incident_status" AS ENUM('open', 'paid_out', 'closed_no_payout');--> statement-breakpoint
CREATE TYPE "public"."policy_status" AS ENUM('pending', 'active', 'expired', 'exhausted');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('unauthorized', 'authorized');--> statement-breakpoint
CREATE TABLE "attestations" (
	"address" text PRIMARY KEY NOT NULL,
	"incident" text NOT NULL,
	"attestor" text NOT NULL,
	"verdict" "verdict" NOT NULL,
	"submitted_at" bigint NOT NULL,
	"signature" text,
	"updated_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"address" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"admin" text NOT NULL,
	"asset_mint" text NOT NULL,
	"asset_decimals" smallint NOT NULL,
	"declaration_delay" bigint NOT NULL,
	"attest_window" bigint NOT NULL,
	"withdraw_delay" bigint NOT NULL,
	"quorum_bps" integer NOT NULL,
	"attestor_count" integer NOT NULL,
	"open_bond" numeric(20, 0) NOT NULL,
	"paused" boolean NOT NULL,
	"updated_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "declarations" (
	"address" text PRIMARY KEY NOT NULL,
	"protocol" text NOT NULL,
	"seq" numeric(20, 0) NOT NULL,
	"program_id" text NOT NULL,
	"ix_discriminator" text NOT NULL,
	"instruction_name" text,
	"not_before" bigint NOT NULL,
	"not_after" bigint,
	"moves_funds" boolean NOT NULL,
	"submitted_at" bigint NOT NULL,
	"effective_at" bigint NOT NULL,
	"revoked_at" bigint,
	"updated_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"address" text PRIMARY KEY NOT NULL,
	"protocol" text NOT NULL,
	"policy" text NOT NULL,
	"trigger_signature" text NOT NULL,
	"trigger_slot" bigint,
	"trigger_block_time" bigint,
	"opener" text NOT NULL,
	"bond" numeric(20, 0) NOT NULL,
	"opened_at" bigint NOT NULL,
	"opened_signature" text,
	"opened_epoch" numeric(20, 0) NOT NULL,
	"deadline" bigint NOT NULL,
	"set_size" integer NOT NULL,
	"votes_unauthorized" integer NOT NULL,
	"votes_authorized" integer NOT NULL,
	"status" "incident_status" NOT NULL,
	"payout" numeric(20, 0) NOT NULL,
	"shortfall" numeric(20, 0) NOT NULL,
	"payout_signature" text,
	"payout_at" bigint,
	"updated_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"last_slot" bigint NOT NULL,
	"last_signature" text
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"address" text PRIMARY KEY NOT NULL,
	"protocol" text NOT NULL,
	"seq" numeric(20, 0) NOT NULL,
	"limit" numeric(20, 0) NOT NULL,
	"retention" numeric(20, 0) NOT NULL,
	"remaining_limit" numeric(20, 0) NOT NULL,
	"start_ts" bigint NOT NULL,
	"end_ts" bigint NOT NULL,
	"premium_paid" numeric(20, 0) NOT NULL,
	"beneficiary" text NOT NULL,
	"status" "policy_status" NOT NULL,
	"updated_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"address" text PRIMARY KEY NOT NULL,
	"protocol" text NOT NULL,
	"vault" text NOT NULL,
	"total_assets" numeric(20, 0) NOT NULL,
	"total_shares" numeric(20, 0) NOT NULL,
	"locked_limit" numeric(20, 0) NOT NULL,
	"open_incidents" bigint NOT NULL,
	"updated_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocols" (
	"address" text PRIMARY KEY NOT NULL,
	"protocol_id" text NOT NULL,
	"authority" text NOT NULL,
	"treasury" text NOT NULL,
	"privileged" text[] NOT NULL,
	"pool" text NOT NULL,
	"new_policies_paused" boolean NOT NULL,
	"next_policy_seq" numeric(20, 0) NOT NULL,
	"next_declaration_seq" numeric(20, 0) NOT NULL,
	"incident_count" numeric(20, 0) NOT NULL,
	"updated_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "attestations_incident_idx" ON "attestations" USING btree ("incident");--> statement-breakpoint
CREATE INDEX "declarations_protocol_idx" ON "declarations" USING btree ("protocol");--> statement-breakpoint
CREATE INDEX "incidents_protocol_idx" ON "incidents" USING btree ("protocol");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "incidents_opened_at_idx" ON "incidents" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "policies_protocol_idx" ON "policies" USING btree ("protocol");--> statement-breakpoint
CREATE INDEX "pools_protocol_idx" ON "pools" USING btree ("protocol");