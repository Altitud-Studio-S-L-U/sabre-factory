// Operator CLI: readable commands over the existing MCP tools. The owner credential stays
// inside the API container (infra/mcp.mjs); nothing here prints or accepts a token.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { invokeMcp } from './mcp.mjs';

const ACTIVE = new Set(['queued', 'running']);
const ATTENTION = new Set(['waiting_input', 'blocked', 'paused', 'failed']);
const CLOSED = new Set(['completed', 'cancelled']);
const SETTLED = new Set(['completed', 'cancelled', 'failed', 'blocked', 'paused', 'waiting_input']);

export const usage = `SABRE operator commands

  sabre runs [--state active|attention|closed|all]
  sabre run <run>                      details, pending questions and tasks
  sabre watch <run>                    follow phases and tools until the run settles
  sabre ask "<message>" [--run <run>]  ask the Supervisor (read-only)
  sabre answer <run> <question> "<answer>"
  sabre pause|resume <run>
  sabre cancel <run> --yes

<run> and <question> accept a unique prefix or suffix of the identifier.`;

export function short(id) {
  return String(id).slice(-8);
}

function cell(value, width) {
  const text = String(value ?? '').replace(/\s+/g, ' ');
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

export function filterRuns(runs, state = 'all') {
  const sets = { active: ACTIVE, attention: ATTENTION, closed: CLOSED };
  if (state === 'all') return runs;
  if (!sets[state]) throw new Error('Use --state active, attention, closed or all.');
  return runs.filter((run) => sets[state].has(run.status));
}

export function formatRuns(runs) {
  if (!runs.length) return 'No runs.';
  const rows = [...runs]
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map((run) => `${cell(short(run.id), 8)}  ${cell(run.status, 13)}  ${cell(run.phase, 16)}  ${cell(run.mode, 8)}  ${cell(run.objective, 60)}`);
  return [`${cell('RUN', 8)}  ${cell('STATUS', 13)}  ${cell('PHASE', 16)}  ${cell('MODE', 8)}  OBJECTIVE`, ...rows].join('\n');
}

export function pendingQuestions(run) {
  return (run.questions ?? []).filter((question) => question.answer == null && question.plan_revision === run.plan_revision);
}

export function formatRun(run) {
  const lines = [
    `${run.objective}`,
    `Run ${run.id} · ${run.mode} · ${run.status} · phase ${run.phase} · revision ${run.plan_revision}`,
    `Usage: ${run.calls_used} calls · ${Number(run.tokens_used).toLocaleString('en-US')} tokens · ${run.active_seconds_used.toFixed(0)} s active`,
  ];
  if (run.summary) lines.push(`Summary: ${run.summary}`);
  if (run.error_code) lines.push(`Stop reason: ${run.error_code}`);
  const questions = pendingQuestions(run);
  if (questions.length) {
    lines.push('', 'Pending questions:');
    for (const question of questions)
      lines.push(`  ${short(question.id)} [${question.kind}] ${question.prompt}${question.options?.length ? ` (${question.options.join(' / ')})` : ''}`);
  }
  if (run.tasks?.length) {
    lines.push('', 'Tasks:');
    for (const task of run.tasks) lines.push(`  ${cell(task.status, 10)} ${task.title}`);
  }
  if (run.evidence?.pr_url) lines.push('', `Draft PR: ${run.evidence.pr_url}`);
  return lines.join('\n');
}

export function formatEvent({ sequence, event }) {
  const time = new Date(event.timestamp).toLocaleTimeString('en-GB', { hour12: false });
  const took = event.duration_ms == null ? '' : ` ${event.duration_ms < 1000 ? `${event.duration_ms} ms` : `${(event.duration_ms / 1000).toFixed(1)} s`}`;
  const error = event.error_code ? ` ${event.error_code}` : '';
  return `${time}  #${sequence}  ${cell(event.kind, 6)} ${cell(event.name, 22)} ${event.state}${took}${error}`;
}

/** Resolve a full identifier from a unique prefix or suffix. */
export function resolveId(candidates, value, noun = 'run') {
  if (!value) throw new Error(`Name the ${noun}.`);
  const exact = candidates.find((id) => id === value);
  if (exact) return exact;
  const matches = candidates.filter((id) => id.startsWith(value) || id.endsWith(value));
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length ? `"${value}" matches several ${noun}s; use more characters.` : `No ${noun} matches "${value}".`);
}

export function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  args.splice(index, 2);
  return value;
}

const invoke = (tool, args = {}) => invokeMcp(Buffer.from(JSON.stringify({ tool, arguments: args })));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
// Question kinds only the owner may answer; over MCP they are filed and confirmed in the console.
const ownerDecisions = new Set(['permission', 'architecture', 'scope', 'exception']);

export async function main(argv, { write = (text) => process.stdout.write(`${text}\n`), call = invoke } = {}) {
  const [command, ...rest] = argv;
  const args = [...rest];
  const runId = async (value) => resolveId((await call('sabre_list_work')).result.map((run) => run.id), value);
  if (args.includes('help') || args.includes('--help')) {
    write(usage);
    return 0;
  }
  switch (command) {
    case 'runs': {
      const state = option(args, '--state') ?? 'all';
      write(formatRuns(filterRuns((await call('sabre_list_work')).result, state)));
      return 0;
    }
    case 'run': {
      write(formatRun(await call('sabre_get_work', { work_id: await runId(args[0]) })));
      return 0;
    }
    case 'watch': {
      const id = await runId(args[0]);
      let cursor = 0;
      for (;;) {
        const page = await call('sabre_execution_events', { work_id: id, after: cursor, limit: 100 });
        for (const item of page.items) write(formatEvent(item));
        cursor = page.next_cursor;
        if (page.has_more) continue;
        const run = await call('sabre_get_work', { work_id: id });
        if (SETTLED.has(run.status)) {
          write(`Run ${short(id)} is ${run.status}${run.error_code ? ` (${run.error_code})` : ''}.`);
          return 0;
        }
        await pause(2000);
      }
    }
    case 'ask': {
      const scope = option(args, '--run');
      const text = args.join(' ').trim();
      if (!text) throw new Error('Write the message: sabre ask "<message>".');
      const workId = scope ? await runId(scope) : null;
      const sent = await call('sabre_talk_supervisor', {
        request: { version: 1, text, work_id: workId, idempotency_key: `cli-${randomUUID()}`, allowed_actions: [] },
      });
      for (let waited = 0; waited < 180_000; waited += 2000) {
        const page = await call('sabre_supervisor_messages', { work_id: workId });
        const message = page.items.find((item) => item.id === sent.id);
        if (message && !['queued', 'running'].includes(message.state)) {
          write(message.reply ?? `The Supervisor stopped: ${message.error_code ?? message.state}.`);
          return message.state === 'completed' ? 0 : 1;
        }
        await pause(2000);
      }
      write(`Still working. Read the reply later in the console (message ${short(sent.id)}).`);
      return 0;
    }
    case 'answer': {
      const [runValue, questionValue, ...answerWords] = args;
      const answer = answerWords.join(' ').trim();
      if (!answer) throw new Error('Usage: sabre answer <run> <question> "<answer>".');
      const run = await call('sabre_get_work', { work_id: await runId(runValue) });
      const pending = pendingQuestions(run);
      const questionId = resolveId(pending.map((question) => question.id), questionValue, 'pending question');
      const request = { work_id: run.id, answer: { question_id: questionId, plan_revision: run.plan_revision, answer } };
      if (ownerDecisions.has(pending.find((question) => question.id === questionId).kind)) {
        const filed = await call('sabre_propose_answer', request);
        write(`This is an owner decision. Nothing changed: confirm it in the console (request ${short(filed.id)}).`);
        return 0;
      }
      const updated = await call('sabre_answer_question', request);
      write(`Answer recorded. Run ${short(updated.id)} is ${updated.status}.`);
      return 0;
    }
    case 'pause':
    case 'resume':
    case 'cancel': {
      if (command === 'cancel' && !args.includes('--yes'))
        throw new Error('Cancelling stops the run for good. Repeat with --yes to confirm.');
      const id = await runId(args.find((value) => !value.startsWith('--')));
      const updated = await call('sabre_control_work', { work_id: id, command });
      write(`Run ${short(updated.id)} is ${updated.status}${updated.control ? ` (${updated.control} requested)` : ''}.`);
      return 0;
    }
    default:
      write(usage);
      return command ? 2 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
