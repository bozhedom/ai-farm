-- NULL means that the provider did not report usage; historical calls stay unknown.
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS input_tokens integer CHECK (input_tokens >= 0);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS output_tokens integer CHECK (output_tokens >= 0);
