const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = path.join(process.cwd(), "data");
const STORES_FILE = path.join(DATA_DIR, "file-search-stores.json");
const DEFAULT_LIST_LIMIT = 50;

let writeLock = Promise.resolve();

function withWriteLock(task) {
  const run = writeLock.then(task, task);
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function ensureStoresFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(STORES_FILE);
  } catch {
    await fs.writeFile(STORES_FILE, "[]", "utf8");
  }
}

async function readStoresUnsafe() {
  await ensureStoresFile();
  const raw = await fs.readFile(STORES_FILE, "utf8");

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeStoresUnsafe(stores) {
  await fs.writeFile(STORES_FILE, JSON.stringify(stores, null, 2), "utf8");
}

function sortStores(stores) {
  return [...stores].sort((a, b) => {
    const bTime = new Date(b.updatedAt || 0).getTime();
    const aTime = new Date(a.updatedAt || 0).getTime();
    return bTime - aTime;
  });
}

function sanitizeLimit(limitInput) {
  const numeric = Number(limitInput);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_LIST_LIMIT;
  }

  return Math.min(Math.floor(numeric), 200);
}

async function listFileSearchStores({ limit = DEFAULT_LIST_LIMIT } = {}) {
  const stores = await readStoresUnsafe();
  const sanitizedLimit = sanitizeLimit(limit);
  return sortStores(stores).slice(0, sanitizedLimit);
}

async function upsertFileSearchStore({
  fileSearchStoreName,
  displayName,
  lastUploadedFileName,
  queryIncrement = 0,
  suggestionIncrement = 0,
} = {}) {
  if (!fileSearchStoreName) {
    throw new Error("fileSearchStoreName is required to update store history.");
  }

  return withWriteLock(async () => {
    const stores = await readStoresUnsafe();
    const nowIso = new Date().toISOString();
    const index = stores.findIndex(
      (store) => store.fileSearchStoreName === fileSearchStoreName,
    );

    const existing =
      index >= 0
        ? stores[index]
        : {
            fileSearchStoreName,
            displayName: displayName || fileSearchStoreName,
            createdAt: nowIso,
            updatedAt: nowIso,
            uploadCount: 0,
            queryCount: 0,
            suggestionCount: 0,
          };

    const updated = {
      ...existing,
      fileSearchStoreName,
      displayName: displayName || existing.displayName || fileSearchStoreName,
      updatedAt: nowIso,
      queryCount: (existing.queryCount || 0) + Math.max(0, queryIncrement),
      suggestionCount: (existing.suggestionCount || 0) + Math.max(0, suggestionIncrement),
    };

    if (lastUploadedFileName) {
      updated.lastUploadedFileName = lastUploadedFileName;
      updated.lastUploadedAt = nowIso;
      updated.uploadCount = (existing.uploadCount || 0) + 1;
    }

    if (queryIncrement > 0) {
      updated.lastQueriedAt = nowIso;
    }

    if (suggestionIncrement > 0) {
      updated.lastSuggestedAt = nowIso;
    }

    if (index >= 0) {
      stores[index] = updated;
    } else {
      stores.push(updated);
    }

    await writeStoresUnsafe(stores);
    return updated;
  });
}

module.exports = {
  listFileSearchStores,
  upsertFileSearchStore,
};
