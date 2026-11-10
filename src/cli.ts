#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadConfig, loadDotEnv, type IrisVeilConfig } from './config.js';
import { IrisVeilError, isIrisVeilError, toIrisVeilError } from './errors.js';
import { createLlmClient, type LlmClient } from './llm.js';
import { createAgentClient, LOCAL_AGENTS, type LocalAgent } from './local-agent.js';
import { parseRunInput, runIrisVeil } from './pipeline.js';
import { renderMarkdown, renderTerminal, safeText } from './format.js';
import { createIrisVeilServer, createJsonLogger } from './server.js';
import { createPrettyLogger, renderBanner, wantsPrettyLogs } from './terminal-log.js';
import { colorDepth } from './theme.js';
import { renderFailure, renderNote, renderProgress, renderRunHeader } from './cli-output.js';
import { createSpinner } from './spinner.js';
import { VERSION } from './version.js';

const HELP = `IrisVeil ${VERSION}: cited lead research and outreach drafts from a company website.

Usage
  irisveil <company-url> [options]     Research a company and draft 3 outreach emails
  irisveil serve [--port N] [--host H] Start the web app (default http://127.0.0.1:3000)

Options
  -t, --to <"Name, Role">   Who the emails are for, e.g. "Cristina Cordova, Chief Operating Officer"
  -o, --offer <text>        What you sell (defaults to SENDER_OFFER in .env)
      --linkedin <file>     Path to the recipient's LinkedIn PDF (profile → More → Save to PDF)
      --x <file>            Path to a Markdown export of the recipient's X profile, made with Grok
      --source <url>        Opt in to a third-party page (news, press release); repeat up to 3 times.
                            Its facts are labelled as reported by that site, never as the company's
      --out <file>          Also save the result (.md for Markdown, .json for JSON)
      --json                Print the full result as JSON instead of the formatted view
  -q, --quiet               Hide progress messages
      --claude              Use your signed-in Claude Code CLI instead of an API key
      --codex               Use your signed-in Codex CLI instead of an API key
      --antigravity         Use your signed-in Antigravity CLI (agy) instead of an API key
      --grok                Use your signed-in Grok CLI instead of an API key
  -p, --port <number>       Port for "serve" (overrides PORT)
      --host <address>      Bind address for "serve" (overrides HOST)
  -h, --help                Show this help
  -v, --version             Show the version

Examples
  irisveil linear.app
  irisveil https://posthog.com --to "Cristina Cordova, Chief Operating Officer" --out posthog.md
  irisveil linear.app --to "Cristina Cordova" --linkedin ~/Downloads/Profile.pdf
  irisveil linear.app --to "Cristina Cordova" --x ~/Downloads/cjc.md
  irisveil linear.app --source https://news.example/linear-launch
  irisveil linear.app --to "Cristina Cordova" --linkedin ~/Downloads/Profile.pdf --x ~/Downloads/cjc.md
  irisveil linear.app --to "Cristina Cordova" --linkedin ~/Downloads/Profile.pdf --x ~/Downloads/cjc.md --claude
  irisveil serve --port 8080
  irisveil serve --claude

Configuration lives in .env (see .env.example). With no API key in .env, pass one of the CLI flags. Docs: https://github.com/YourAKShaw/irisveil`;

const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

/** Banner and styled progress only when a person is watching stderr. */
function decorated(): boolean {
  const forced = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
  return Boolean(process.stderr.isTTY || forced);
}

function printError(error: unknown): void {
  const failure = toIrisVeilError(error);
  const detail = process.env.IRISVEIL_DEBUG ? failure.detail : undefined;
  if (decorated()) {
    process.stderr.write(renderFailure(failure.message, detail, colorDepth(process.stderr)));
    return;
  }
  process.stderr.write(`✗ ${safeText(failure.message)}\n`);
  if (detail) process.stderr.write(`  detail: ${safeText(detail)}\n`);
}

/** Reads a profile file given on the command line into the same shape the web app uploads. */
async function readProfileArg(path: string | undefined, label: string): Promise<{ name: string; data: string } | undefined> {
  if (!path) return undefined;
  const resolved = path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
  try {
    return { name: basename(resolved), data: (await readFile(resolved)).toString('base64') };
  } catch {
    throw new IrisVeilError('INVALID_INPUT', `Could not read the ${label} at ${path}.`);
  }
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        to: { type: 'string', short: 't' },
        offer: { type: 'string', short: 'o' },
        linkedin: { type: 'string' },
        x: { type: 'string' },
        source: { type: 'string', multiple: true },
        out: { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        claude: { type: 'boolean' },
        codex: { type: 'boolean' },
        antigravity: { type: 'boolean' },
        grok: { type: 'boolean' },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nRun "irisveil --help" for usage.\n`);
    return EXIT.usage;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  const [command, ...extra] = positionals;
  if (!command) {
    process.stderr.write(`${HELP}\n`);
    return EXIT.usage;
  }
  if (extra.length > 0) {
    process.stderr.write(`Unexpected argument: ${extra[0]}. Quote values that contain spaces.\n`);
    return EXIT.usage;
  }

  const agents = LOCAL_AGENTS.filter((agent) => values[agent]);
  if (agents.length > 1) {
    process.stderr.write(`Choose one of ${agents.map((a) => `--${a}`).join(', ')}, not several.\n`);
    return EXIT.usage;
  }
  const agent: LocalAgent | undefined = agents[0];

  let config: IrisVeilConfig;
  let llm: LlmClient;
  try {
    loadDotEnv();
    config = loadConfig(process.env, { localAgent: agent !== undefined });
    llm = agent ? createAgentClient(agent, { timeoutMs: config.llm.timeoutMs }) : createLlmClient(config.llm);
  } catch (error) {
    printError(error);
    return EXIT.usage;
  }

  if (command === 'serve') return serve(config, llm, values.port, values.host);

  let input;
  try {
    const [linkedin, x] = await Promise.all([readProfileArg(values.linkedin, 'LinkedIn PDF'), readProfileArg(values.x, 'X Markdown file')]);
    input = parseRunInput({ url: command, recipient: values.to, offer: values.offer, linkedin, x, sources: values.source });
  } catch (error) {
    printError(error);
    return EXIT.usage;
  }

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const fancy = decorated() && !values.quiet;
  const errDepth = colorDepth(process.stderr);
  const note = (message: string) => process.stderr.write(fancy ? renderNote(message, errDepth) : `› ${safeText(message)}\n`);
  if (fancy) {
    process.stderr.write(
      renderRunHeader(
        { target: input.url, recipient: input.recipient ?? undefined, linkedin: values.linkedin, x: values.x, provider: llm.provider, model: llm.model, version: VERSION },
        errDepth,
      ),
    );
  }

  // Animate only on a real terminal; FORCE_COLOR into a pipe gets the static lines.
  const spinner = fancy && process.stderr.isTTY && errDepth !== 'none' ? createSpinner({ stream: process.stderr, depth: errDepth }) : undefined;

  try {
    const result = await runIrisVeil(input, {
      config,
      llm,
      signal: controller.signal,
      onProgress: values.quiet
        ? undefined
        : (event) => {
            if (!fancy) return process.stderr.write(`› ${safeText(event.message)}\n`);
            if (!spinner) return process.stderr.write(renderProgress(event, errDepth));
            spinner.print(renderProgress(event, errDepth));
            if (event.stage === 'done') spinner.stop();
            else spinner.set(event.message);
          },
    });
    spinner?.stop();

    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(renderTerminal(result, { depth: colorDepth(process.stdout), width: process.stdout.columns }));

    if (values.out) {
      const content = values.out.toLowerCase().endsWith('.json') ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result);
      await writeFile(values.out, content, 'utf8');
      note(`Saved ${values.out}`);
    }
    return EXIT.ok;
  } catch (error) {
    spinner?.stop();
    printError(error);
    return isIrisVeilError(error) && error.code === 'ABORTED' ? 130 : EXIT.failure;
  }
}

async function serve(config: IrisVeilConfig, llm: LlmClient, portFlag: string | undefined, hostFlag: string | undefined): Promise<number> {
  const port = portFlag === undefined ? config.server.port : Number(portFlag);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    process.stderr.write(`Invalid --port: ${portFlag}\n`);
    return EXIT.usage;
  }
  const pretty = wantsPrettyLogs(process.stdout);
  const depth = colorDepth(process.stdout);
  const logger = pretty ? createPrettyLogger({ depth, animate: process.stdout.isTTY ? process.stdout : undefined }) : createJsonLogger();
  const app = await createIrisVeilServer({ config, llm, logger });
  const address = await app.listen(port, hostFlag ?? config.server.host);
  const listening = {
    url: `http://${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`,
    provider: llm.provider,
    model: llm.model,
    version: VERSION,
  };
  if (pretty) process.stdout.write(renderBanner(listening, depth));
  logger.info('listening', listening);

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger.info('shutting down', { signal });
      app.close(10_000).then(() => resolve(EXIT.ok));
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    printError(error);
    process.exitCode = EXIT.failure;
  },
);
