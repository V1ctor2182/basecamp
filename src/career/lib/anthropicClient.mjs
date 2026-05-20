// Lazy-init Anthropic SDK client. Module-level cache so the entire process
// shares one client (the SDK manages its own HTTP keep-alive pool).
//
// First project use of LLM. Subsequent rooms (02-stage-b-sonnet, tailor,
// applier-feedback) consume getClient() too — keep this module dependency-
// thin and surface-stable.
//
// Three backends, picked by getClient():
//   - MOCK_ANTHROPIC=1            → canned mock client (smokes, no $/key)
//   - CAREER_LLM_BACKEND=cli      → `claude -p` CLI client (uses the local
//                                   Claude Code subscription, no API key)
//   - ANTHROPIC_API_KEY set       → real Anthropic SDK client
//
// The CLI backend exists so the career system runs off a Claude Code
// subscription without provisioning a separate ANTHROPIC_API_KEY.

import { spawn } from 'child_process';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

let _client = null;

// Returns the cached client, lazy-creating on first call. Throws ConfigError
// if no backend can be resolved.
export function getClient() {
  if (_client) return _client;
  if (process.env.MOCK_ANTHROPIC === '1') {
    _client = makeMockClient();
    return _client;
  }
  if (process.env.CAREER_LLM_BACKEND === 'cli') {
    _client = makeCliClient();
    return _client;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'No LLM backend configured. Set ANTHROPIC_API_KEY for the API, or ' +
        'CAREER_LLM_BACKEND=cli to use the local `claude` CLI (Claude Code ' +
        'subscription). For smoke tests, set MOCK_ANTHROPIC=1.'
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

// ── CLI backend ─────────────────────────────────────────────────────────
//
// Shells out to `claude -p --output-format json`. The CLI uses whatever auth
// the local Claude Code install has (subscription OAuth or its own key), so
// no ANTHROPIC_API_KEY is needed in this process.
//
// The Anthropic Tools API contract (stop_reason:'tool_use', tool_use blocks)
// is NOT reproduced — `claude -p` runs tools itself. The CLI client always
// returns stop_reason:'end_turn'. stageBTools' runToolUseLoop therefore exits
// after one round; web lookups happen inside the CLI turn when tools are
// allowed. Local tools (verify_job_posting) are not invoked in this mode.

const CLI_TIMEOUT_MS = 240_000;

// Flatten params.system (string | array of text blocks) to a plain string.
function flattenSystem(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

// Flatten params.messages into a single prompt string. For the API-style
// calls the career runners make, round 1 is a single user message; tool
// rounds are never reached because the CLI returns end_turn.
function flattenMessages(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const m of messages) {
    const content = m?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((b) => {
          if (typeof b === 'string') return b;
          if (b?.type === 'text') return b.text;
          if (b?.type === 'tool_result') {
            return `[tool_result] ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (!text) continue;
    if (messages.length > 1 && m.role) {
      parts.push(`${m.role === 'assistant' ? 'Assistant' : 'Human'}: ${text}`);
    } else {
      parts.push(text);
    }
  }
  return parts.join('\n\n');
}

// Normalize the CLI's usage object to the SDK usage shape downstream cost
// code expects.
function normalizeUsage(u) {
  const usage = {
    input_tokens: Number(u?.input_tokens) || 0,
    output_tokens: Number(u?.output_tokens) || 0,
    cache_creation_input_tokens: Number(u?.cache_creation_input_tokens) || 0,
    cache_read_input_tokens: Number(u?.cache_read_input_tokens) || 0,
  };
  const ws = u?.server_tool_use?.web_search_requests;
  if (typeof ws === 'number') {
    usage.server_tool_use = { web_search_requests: ws };
  }
  return usage;
}

function runClaudeCli(args, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: os.tmpdir(), // avoid CLAUDE.md auto-discovery from the repo
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? new ConfigError('`claude` CLI not found on PATH — install Claude Code or unset CAREER_LLM_BACKEND')
          : e
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function makeCliClient() {
  return {
    messages: {
      async create(params) {
        const model = params?.model || 'claude-sonnet-4-6';
        const system = flattenSystem(params?.system);
        const prompt = flattenMessages(params?.messages);
        const hasTools = Array.isArray(params?.tools) && params.tools.length > 0;

        const args = [
          '-p',
          '--output-format',
          'json',
          '--no-session-persistence',
          '--model',
          model,
        ];
        if (system) args.push('--system-prompt', system);
        if (hasTools) {
          args.push('--allowedTools', 'WebSearch', 'WebFetch');
        } else {
          args.push('--tools', '');
        }

        const raw = await runClaudeCli(args, prompt);
        let j;
        try {
          j = JSON.parse(raw);
        } catch {
          throw new Error(`claude CLI returned non-JSON: ${raw.slice(0, 300)}`);
        }
        if (j.is_error || j.subtype !== 'success') {
          throw new Error(`claude CLI error: ${j.result || j.subtype || 'unknown'}`);
        }
        return {
          id: j.uuid || 'msg_cli',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: String(j.result ?? '') }],
          stop_reason: j.stop_reason || 'end_turn',
          usage: normalizeUsage(j.usage),
        };
      },
    },
  };
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
