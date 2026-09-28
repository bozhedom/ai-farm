ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS reserved_microusd integer NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS charged_microusd integer NOT NULL DEFAULT 0 CHECK (charged_microusd >= 0);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS actual_microusd integer CHECK (actual_microusd >= 0);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS cached_tokens integer CHECK (cached_tokens >= 0 AND cached_tokens <= input_tokens);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS cache_write_tokens integer CHECK (cache_write_tokens >= 0 AND cache_write_tokens <= input_tokens);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS reasoning_tokens integer CHECK (reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS provider_response_id text;
