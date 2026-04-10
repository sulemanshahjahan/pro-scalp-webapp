/**
 * Lightweight structured logger
 *
 * Drop-in replacement for console.log/warn/error with JSON output in production.
 * Gradually replace console.* calls with log.info/warn/error.
 *
 * In production (NODE_ENV=production): outputs JSON lines for log aggregation
 * In development: outputs human-readable format (same as console.log)
 */

const isProd = process.env.NODE_ENV === 'production';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function formatMessage(level: LogLevel, module: string, msg: string, data?: Record<string, unknown>): string {
  if (isProd) {
    return JSON.stringify({
      level,
      module,
      msg,
      ...data,
      ts: new Date().toISOString(),
    });
  }
  const prefix = `[${module}]`;
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  return `${prefix} ${msg}${dataStr}`;
}

export function createLogger(module: string) {
  return {
    debug(msg: string, data?: Record<string, unknown>) {
      if (isProd) return; // suppress debug in production
      console.log(formatMessage('debug', module, msg, data));
    },
    info(msg: string, data?: Record<string, unknown>) {
      console.log(formatMessage('info', module, msg, data));
    },
    warn(msg: string, data?: Record<string, unknown>) {
      console.warn(formatMessage('warn', module, msg, data));
    },
    error(msg: string, data?: Record<string, unknown>) {
      console.error(formatMessage('error', module, msg, data));
    },
  };
}

// Default logger for quick use
export const log = createLogger('app');
