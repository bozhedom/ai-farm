-- Explicit operator receipt checks, never automatic retry or a refund of a failed call.
CREATE TABLE trading_manager_cost_reviews (
  call_id uuid PRIMARY KEY REFERENCES tool_calls(id),
  provider_response_id text NOT NULL,
  actual_microusd integer NOT NULL CHECK(actual_microusd>=0),
  charged_microusd integer NOT NULL CHECK(charged_microusd>=actual_microusd),
  receipt jsonb NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
