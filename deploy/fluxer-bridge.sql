-- Name sync access in Fluxer's database (docs/design/history-rewrite.md).
--
-- Run once as the owner of fluxer_kv, with the role's password in a psql
-- variable so it never appears in shell history:
--
--   psql -v bridge_password="$(cat password-file)" -f fluxer-bridge.sql
--
-- The role can log in and run the functions below. It gets no access to
-- any table: each function checks its own arguments and touches only the
-- webhook_name of webhook messages.

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE bifrost_bridge LOGIN PASSWORD %L', :'bridge_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bifrost_bridge')
\gexec
SELECT format('ALTER ROLE bifrost_bridge LOGIN PASSWORD %L', :'bridge_password')
\gexec

CREATE SCHEMA IF NOT EXISTS bifrost;
REVOKE ALL ON SCHEMA bifrost FROM PUBLIC;
GRANT USAGE ON SCHEMA bifrost TO bifrost_bridge;

-- Sets webhook_name on up to 500 messages, given by their fluxer_kv row
-- keys. Only rows that are webhook messages with no user author change.
-- Returns how many rows changed.
CREATE OR REPLACE FUNCTION bifrost.set_webhook_names(p_keys text[], p_name text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    changed integer;
BEGIN
    IF p_keys IS NULL OR cardinality(p_keys) > 500 THEN
        RAISE EXCEPTION 'set_webhook_names takes 0 to 500 keys';
    END IF;
    IF p_name IS NULL OR char_length(btrim(p_name)) = 0
        OR char_length(p_name) > 80 THEN
        RAISE EXCEPTION 'set_webhook_names needs a name of 1 to 80 characters';
    END IF;
    UPDATE public.fluxer_kv
    SET row_data = row_data || jsonb_build_object('webhook_name', p_name),
        updated_at = now()
    WHERE table_name = 'messages'
      AND row_key = ANY (p_keys)
      AND jsonb_typeof(row_data -> 'webhook_id') = 'object'
      AND COALESCE(jsonb_typeof(row_data -> 'author_id'), 'null') = 'null'
      AND row_data ->> 'webhook_name' IS DISTINCT FROM p_name;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION bifrost.set_webhook_names(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bifrost.set_webhook_names(text[], text) TO bifrost_bridge;

-- Gives threads a webhook owns to p_owner (the bot's user ID). Guild-sync
-- creates forum posts through a webhook, and Fluxer then shows the OP tag
-- on every copy, because each copy's author is that same webhook
-- (fluxer_app ForumChannelUtils.ts isOriginalPoster). Threads people start
-- keep their owner. Returns how many threads changed.
CREATE OR REPLACE FUNCTION bifrost.give_webhook_threads(p_owner text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    changed integer;
BEGIN
    IF p_owner IS NULL OR p_owner !~ '^[0-9]{1,20}$' THEN
        RAISE EXCEPTION 'give_webhook_threads needs a user ID';
    END IF;
    UPDATE public.fluxer_kv c
    SET row_data = c.row_data || jsonb_build_object('owner_id',
            jsonb_build_object('__fluxer_type', 'bigint', 'value', p_owner)),
        updated_at = now()
    WHERE c.table_name = 'channels'
      AND (c.row_data ->> 'type') IN ('10', '11', '12')
      AND c.row_data -> 'owner_id' ->> 'value' IN (
          SELECT w.row_data -> 'webhook_id' ->> 'value'
          FROM public.fluxer_kv w WHERE w.table_name = 'webhooks');
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION bifrost.give_webhook_threads(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bifrost.give_webhook_threads(text) TO bifrost_bridge;

-- Sets channel_state.created_bucket to at most the given bucket, for up to
-- 1000 channels. Fluxer's search rebuild never lists messages below a
-- channel's created_bucket (fluxer_api MessageDataRepository.ts:152), and
-- every new message resets it to the channel's creation bucket
-- (MessageDataRepository.ts:547,565). Bifrost moved history copies to
-- their Discord IDs, years before the channels were created, so it keeps
-- the value lowered. p_buckets: [{"channel_id": "<id>", "bucket": <int>}].
-- Returns how many channels changed.
CREATE OR REPLACE FUNCTION bifrost.lower_created_buckets(p_buckets jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    changed integer;
BEGIN
    IF p_buckets IS NULL OR jsonb_typeof(p_buckets) <> 'array'
        OR jsonb_array_length(p_buckets) > 1000 THEN
        RAISE EXCEPTION 'lower_created_buckets takes an array of up to 1000 entries';
    END IF;
    UPDATE public.fluxer_kv s
    SET row_data = s.row_data || jsonb_build_object('created_bucket', b.bucket),
        updated_at = now()
    FROM jsonb_to_recordset(p_buckets) AS b(channel_id text, bucket integer)
    WHERE s.table_name = 'channel_state'
      AND b.channel_id ~ '^[0-9]{1,20}$'
      AND b.bucket >= 0
      AND s.row_key = '{"__fluxer_type":"bigint","value":"' || b.channel_id || '"}'
      AND COALESCE((s.row_data ->> 'created_bucket')::integer, 2147483647) > b.bucket;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION bifrost.lower_created_buckets(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bifrost.lower_created_buckets(jsonb) TO bifrost_bridge;
