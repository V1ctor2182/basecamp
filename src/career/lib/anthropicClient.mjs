// Lazy-init Anthropic SDK client. Module-level cache so the entire process
// shares one client (the SDK manages its own HTTP keep-alive pool).
//
// First project use of LLM. Subsequent rooms (02-stage-b-sonnet, tailor,
// applier-feedback) consume getClient() too — keep this module dependency-
// thin and surface-stable.
//
// MOCK_ANTHROPIC=1 returns a canned mock client so smokes can run end-to-end
// without spending real $ or requiring an API key. Real keys still required
// for production scans.

import Anthropic from '@anthropic-ai/sdk';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

let _client = null;

// Returns the cached client, lazy-creating on first call. Throws ConfigError
// if ANTHROPIC_API_KEY is missing in non-mock mode.
export function getClient() {
  if (_client) return _client;
  if (process.env.MOCK_ANTHROPIC === '1') {
    _client = makeMockClient();
    return _client;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'ANTHROPIC_API_KEY env var not set. Set it in your shell or a .env file. ' +
        'For local smoke tests without a real key, set MOCK_ANTHROPIC=1.'
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

// Test helper: drop the cached client so a fresh getClient() pulls env again.
// Used by the smoke to alternate between MOCK and unset-key modes.
export function _resetClientForTesting() {
  _client = null;
}

// Mock client: returns canned content + plausible token usage so cost
// computations downstream are non-zero. Score 4.0 is an arbitrary mid-high
// value; smokes can override with their own deps if they need finer control.
function makeMockClient() {
  return {
    messages: {
      async create(_params) {
        return {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: _params?.model ?? 'claude-haiku-4-5-20251001',
          content: [
            {
              type: 'text',
              text: 'Score: 4.0/5 — Mock evaluation. Strong fit on listed core requirements.',
            },
          ],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 800,
            output_tokens: 30,
            // SDK v0.92.0 returns null when caching is not used (the field
            // is `number | null`). Match that shape so downstream cost
            // computation in m2 must defensively `?? 0` — same code path
            // as production hits.
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        };
      },
    },
  };
}

// Re-export Anthropic's typed error classes so callers can `instanceof`
// against them without importing the SDK directly. Subsequent rooms (m2
// retry logic) use these to distinguish 5xx/429 (retry) from 4xx (fast fail).
export const APIError = Anthropic.APIError;
export const AuthenticationError = Anthropic.AuthenticationError;
export const RateLimitError = Anthropic.RateLimitError;
export const APIConnectionError = Anthropic.APIConnectionError;
