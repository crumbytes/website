import { redact } from './audit.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// One JSON object per line, which Vercel's log drains and viewers can filter.
// Fields pass through the same redactor as the audit log, so a secret-like key is
// masked even if a caller passes one by mistake. Request bodies are never logged.
export function createLogger({ level = 'info', service = 'website-hub', environment, write = line => process.stdout.write(`${line}\n`) } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (name, event, fields) => {
    if (LEVELS[name] < threshold) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: name, service, environment, event, ...redact(fields ?? {}) }));
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields)
  };
}
