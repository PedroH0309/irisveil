import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IrisError } from './errors.js';
import type { ChatMessage, CompleteOptions, LlmClient, LlmCompletion } from './llm.js';

/**
 * Runs Iris's two prompts through an AI coding CLI that is already installed and signed in
 * (Claude Code, Codex, Antigravity or Grok) instead of an API key. Each call is one headless,
 * single-turn run in an empty temporary folder, with web search and tools off where the CLI
 * allows it, so the agent only reads the prompt and answers. Iris still validates the output.
 */

export const LOCAL_AGENTS = ['claude', 'codex', 'antigravity', 'grok'] as const;
export type LocalAgent = (typeof LOCAL_AGENTS)[number];

export const AGENT_LABEL: Record<LocalAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  grok: 'Grok',
};

/** Prompts travel as one argument; Linux caps a single argument at 128 KiB. */
const MAX_PROMPT_CHARS = 120_000;
const MAX_OUTPUT_CHARS = 2_000_000;

interface Invocation {
  command: string;
  args: string[];
  /** Codex prints logs to stdout, so its answer is read from this file instead. */
  outputFile?: string;
}

function invocation(agent: LocalAgent, prompt: string, dir: string): Invocation {
  switch (agent) {
    case 'claude':
      return { command: 'claude', args: ['-p', prompt, '--output-format', 'text', '--tools', '', '--no-session-persistence', '--strict-mcp-config'] };
    case 'codex': {
      const outputFile = join(dir, 'answer.txt');
      return { command: 'codex', args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-o', outputFile, prompt], outputFile };
    }
    case 'antigravity':
      return { command: 'agy', args: ['-p', prompt, '--output-format', 'text', '--disable-slash-commands'] };
    case 'grok':
      return { command: 'grok', args: ['-p', prompt, '--output-format', 'plain', '--disable-web-search'] };
  }
}

/** The CLIs take one prompt, so the chat (system, user, any repair turns) becomes one labelled text. */
export function flattenMessages(messages: ChatMessage[]): string {
  return messages
    .map((message) => (message.role === 'system' ? message.content : `[${message.role.toUpperCase()}]\n${message.content}`))
    .join('\n\n');
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function createAgentClient(agent: LocalAgent, options: { timeoutMs: number }): LlmClient {
  return {
    provider: AGENT_LABEL[agent],
    model: `${agent} CLI`,
    async complete(messages: ChatMessage[], callOptions: CompleteOptions): Promise<LlmCompletion> {
      const prompt = flattenMessages(messages);
      if (prompt.length > MAX_PROMPT_CHARS) throw new IrisError('LLM_BAD_OUTPUT', 'The prompt is too large to pass to a local CLI.');
      const dir = await mkdtemp(join(tmpdir(), 'iris-agent-'));
      try {
        const call = invocation(agent, prompt, dir);
        const stdout = await run(call, dir, AGENT_LABEL[agent], options.timeoutMs, callOptions.signal);
        const text = call.outputFile ? await readFile(call.outputFile, 'utf8').catch(() => stdout) : stdout;
        if (!text.trim()) throw new IrisError('LLM_BAD_OUTPUT', `${AGENT_LABEL[agent]} returned an empty answer.`);
        return { text, usage: { promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(text) } };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function run(call: Invocation, cwd: string, label: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new IrisError('ABORTED', 'The run was cancelled.'));
    const child = spawn(call.command, call.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error: IrisError | undefined, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        child.kill('SIGTERM');
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new IrisError('LLM_UNAVAILABLE', `${label} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)),
      timeoutMs,
    );
    const onAbort = () => finish(new IrisError('ABORTED', 'The run was cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        new IrisError(
          'LLM_UNAVAILABLE',
          error.code === 'ENOENT' ? `The ${call.command} command was not found. Install ${label} and sign in, then try again.` : `${label} could not be started.`,
          { detail: error.message },
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) finish(undefined, stdout);
      else
        finish(
          new IrisError('LLM_UNAVAILABLE', `${label} exited with an error. Check that it is signed in by running ${call.command} once.`, {
            detail: stderr.trim().slice(-800),
          }),
        );
    });
  });
}
