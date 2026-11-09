#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { loadConfig, loadDotEnv, type IrisConfig } from './config.js';
import { isIrisError, toIrisError } from './errors.js';
import { createLlmClient } from './llm.js';
import { parseRunInput, runIris } from './pipeline.js';
import { renderMarkdown, renderTerminal, safeText } from './format.js';
import { createIrisServer, createJsonLogger } from './server.js';
import { createPrettyLogger, renderBanner, wantsPrettyLogs } from './terminal-log.js';
import { colorDepth } from './theme.js';
import { renderFailure, renderNote, renderProgress, renderRunHeader } from './cli-output.js';
import { createSpinner } from './spinner.js';
import { VERSION } from './version.js';

const HELP = `Iris ${VERSION}: cited lead research and outreach drafts from a company website.

Usage
  iris <company-url> [options]     Research a company and draft 3 outreach emails
  iris serve [--port N] [--host H] Start the web app (default http://127.0.0.1:3000)

Options
  -t, --to <"Name, Role">   Who the emails are for, e.g. "Priya Rao, Head of Growth"
  -o, --offer <text>        What you sell (defaults to SENDER_OFFER in .env)
      --out <file>          Also save the result (.md for Markdown, .json for JSON)
      --json                Print the full result as JSON instead of the formatted view
  -q, --quiet               Hide progress messages
  -p, --port <number>       Port for "serve" (overrides PORT)
      --host <address>      Bind address for "serve" (overrides HOST)
  -h, --help                Show this help
  -v, --version             Show the version

Examples
  iris linear.app
  iris https://posthog.com --to "Priya Rao, Head of Growth" --out posthog.md
  iris serve --port 8080

Configuration lives in .env (see .env.example). Docs: https://github.com/YourAKShaw/iris`;

const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

/** Banner and styled progress only when a person is watching stderr. */
function decorated(): boolean {
  const forced = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
  return Boolean(process.stderr.isTTY || forced);
}

function printError(error: unknown): void {
  const failure = toIrisError(error);
  const detail = process.env.IRIS_DEBUG ? failure.detail : undefined;
  if (decorated()) {
    process.stderr.write(renderFailure(failure.message, detail, colorDepth(process.stderr)));
    return;
  }
  process.stderr.write(`✗ ${safeText(failure.message)}\n`);
  if (detail) process.stderr.write(`  detail: ${safeText(detail)}\n`);
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
        out: { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nRun "iris --help" for usage.\n`);
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

  let config: IrisConfig;
  try {
    loadDotEnv();
    config = loadConfig();
  } catch (error) {
    printError(error);
    return EXIT.usage;
  }

  if (command === 'serve') return serve(config, values.port, values.host);

  let input;
  try {
    input = parseRunInput({ url: command, recipient: values.to, offer: values.offer });
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
        { target: input.url, recipient: input.recipient ?? undefined, provider: config.llm.provider, model: config.llm.model, version: VERSION },
        errDepth,
      ),
    );
  }

  // Animate only on a real terminal; FORCE_COLOR into a pipe gets the static lines.
  const spinner = fancy && process.stderr.isTTY && errDepth !== 'none' ? createSpinner({ stream: process.stderr, depth: errDepth }) : undefined;

  try {
    const result = await runIris(input, {
      config,
      llm: createLlmClient(config.llm),
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
    return isIrisError(error) && error.code === 'ABORTED' ? 130 : EXIT.failure;
  }
}

async function serve(config: IrisConfig, portFlag: string | undefined, hostFlag: string | undefined): Promise<number> {
  const port = portFlag === undefined ? config.server.port : Number(portFlag);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    process.stderr.write(`Invalid --port: ${portFlag}\n`);
    return EXIT.usage;
  }
  const pretty = wantsPrettyLogs(process.stdout);
  const depth = colorDepth(process.stdout);
  const logger = pretty ? createPrettyLogger({ depth, animate: process.stdout.isTTY ? process.stdout : undefined }) : createJsonLogger();
  const app = await createIrisServer({ config, llm: createLlmClient(config.llm), logger });
  const address = await app.listen(port, hostFlag ?? config.server.host);
  const listening = {
    url: `http://${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`,
    provider: config.llm.provider,
    model: config.llm.model,
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
