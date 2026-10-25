-- CrumByte Remote Support backend schema (PostgreSQL)
-- Migration draft. Not deployed. Apply only after authentication, RLS,
-- payment webhook verification and role authorization are implemented.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE support_customers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 auth_subject text UNIQUE NOT NULL,
 email text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_technicians(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 auth_subject text UNIQUE NOT NULL,
 display_name text NOT NULL,
 active boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_tickets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL REFERENCES support_customers(id),
 technician_id uuid REFERENCES support_technicians(id),
 subject text NOT NULL,
 description text NOT NULL,
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','assigned','scheduled','active','resolved','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_wallets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL UNIQUE REFERENCES support_customers(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Signed, immutable ledger; refunds and reversals are new entries, not edits.
CREATE TABLE support_credit_ledger(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 wallet_id uuid NOT NULL REFERENCES support_wallets(id),
 delta_seconds bigint NOT NULL CHECK(delta_seconds <> 0),
 kind text NOT NULL CHECK(kind IN ('purchase','adjustment','reservation','usage','refund','release')),
 external_reference text UNIQUE,
 note text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_credit_ledger_wallet_time ON support_credit_ledger(wallet_id,created_at);
CREATE TABLE support_sessions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 ticket_id uuid NOT NULL REFERENCES support_tickets(id),
 wallet_id uuid NOT NULL REFERENCES support_wallets(id),
 technician_id uuid NOT NULL REFERENCES support_technicians(id),
 state text NOT NULL DEFAULT 'awaiting_consent' CHECK(state IN ('awaiting_consent','ready','running','paused','expired','completed','cancelled')),
 consent_at timestamptz,
 started_at timestamptz,
 billable_until timestamptz,
 last_metered_at timestamptz,
 ended_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(started_at IS NULL OR consent_at IS NOT NULL),
 CHECK(ended_at IS NULL OR started_at IS NOT NULL)
);
CREATE INDEX support_sessions_ticket ON support_sessions(ticket_id);
CREATE TABLE support_session_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES support_sessions(id),
 event_type text NOT NULL,
 actor_subject text NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_session_events_session ON support_session_events(session_id,occurred_at);
CREATE TABLE support_payment_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 processor text NOT NULL,
 processor_event_id text NOT NULL UNIQUE,
 customer_id uuid REFERENCES support_customers(id),
 status text NOT NULL CHECK(status IN ('pending','verified','rejected')),
 credited_ledger_id uuid UNIQUE REFERENCES support_credit_ledger(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
