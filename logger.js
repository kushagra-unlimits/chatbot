const BACKEND_LOGS_ENABLED = String(process.env.BACKEND_LOGS || "true").toLowerCase() !== "false";
const MAX_STRING_LENGTH = Number(process.env.BACKEND_LOG_MAX_STRING || 280);

function sanitizeMeta(value, depth = 0) {
  if (depth > 2) {
    return "[truncated-depth]";
  }

  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LENGTH) {
      return value;
    }

    return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeMeta(item, depth + 1));
  }

  if (typeof value === "object") {
    const result = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = sanitizeMeta(nestedValue, depth + 1);
    }
    return result;
  }

  return String(value);
}

function printLog(level, scope, event, meta) {
  if (!BACKEND_LOGS_ENABLED) {
    return;
  }

  const timestamp = new Date().toISOString();
  const normalizedMeta = sanitizeMeta(meta || {});
  const payload = Object.keys(normalizedMeta).length > 0 ? ` ${JSON.stringify(normalizedMeta)}` : "";

  const line = `[${timestamp}] [${scope}] [${level}] ${event}${payload}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function createLogger(scope) {
  return {
    info(event, meta = {}) {
      printLog("info", scope, event, meta);
    },
    warn(event, meta = {}) {
      printLog("warn", scope, event, meta);
    },
    error(event, meta = {}) {
      printLog("error", scope, event, meta);
    },
  };
}

module.exports = {
  createLogger,
};
