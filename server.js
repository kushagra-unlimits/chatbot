const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");

dotenv.config();
const { createLogger } = require("./logger");

const {
  createFileSearchStore,
  uploadFileToStore,
  generateAnswerWithFileSearch,
  generateSuggestedQuestions,
} = require("./search");
const { saveChatExchange, getFirestoreStatus } = require("./db-firebase");
const {
  buildDeterministicReport,
  normalizeSourceLinks,
} = require("./monitoring-report");
const {
  listFileSearchStores,
  upsertFileSearchStore,
} = require("./store-history");

const app = express();
const logger = createLogger("server");
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(process.cwd(), "tmp-uploads");
const FILE_UPLOAD_MAX_MB = Number(process.env.FILE_UPLOAD_MAX_MB) || 15;

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: FILE_UPLOAD_MAX_MB * 1024 * 1024,
  },
});

function getCorsOrigins() {
  const originEnv = process.env.CORS_ORIGIN;
  if (!originEnv || !originEnv.trim()) {
    return true;
  }

  return originEnv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseLinks(value) {
  return normalizeSourceLinks(value);
}

function parseOptionalData(value, label) {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${label} must be valid JSON.`);
    }
  }

  if (typeof value === "object") {
    return value;
  }

  throw new Error(`${label} must be an object, array, or JSON string.`);
}

function appendSourcesSection(text, sourceLinks) {
  const clean = (text || "").trim();
  const sourceBlock = sourceLinks.map((link) => `- ${link}`).join("\n");

  if (sourceLinks.length === 0) {
    return clean;
  }

  if (!clean) {
    return `Sources\n${sourceBlock}`;
  }

  if (/\bsources\b/i.test(clean)) {
    return clean;
  }

  return `${clean}\n\nSources\n${sourceBlock}`;
}

function normalizeUploadMimeType(uploadedFile) {
  const original = String(uploadedFile?.mimetype || "").trim().toLowerCase();
  const cleaned = original.split(";")[0].trim();
  const extension = path.extname(uploadedFile?.originalname || "").toLowerCase();

  // CSV uploads often come as vendor types or include charset parameters.
  // File Search accepts plain text reliably, so normalize CSV-like uploads.
  if (extension === ".csv" || cleaned === "text/csv" || cleaned === "application/vnd.ms-excel") {
    return "text/plain";
  }

  return cleaned || "text/plain";
}

app.use(cors({ origin: getCorsOrigins() }));
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) {
    return next();
  }

  const requestId = randomUUID();
  const startedAt = Date.now();

  req.requestId = requestId;

  logger.info("request.start", {
    requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
  });

  res.on("finish", () => {
    logger.info("request.end", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  return next();
});

app.get("/api/health", (req, res) => {
  logger.info("health.check", {
    requestId: req.requestId || null,
  });

  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uploadMaxMb: FILE_UPLOAD_MAX_MB,
    firestore: getFirestoreStatus(),
  });
});

app.post("/api/file-search/store", async (req, res) => {
  const requestId = req.requestId || null;

  try {
    const displayName = String(req.body?.displayName || "").trim();

    logger.info("file_search.store.create.start", {
      requestId,
      displayName: displayName || null,
    });

    const store = await createFileSearchStore(displayName);

    try {
      await upsertFileSearchStore({
        fileSearchStoreName: store.name,
        displayName: store.displayName || displayName || store.name,
      });
    } catch (historyError) {
      logger.warn("file_search.store.history_upsert_failed", {
        requestId,
        fileSearchStoreName: store.name,
        error: historyError.message,
      });
    }

    logger.info("file_search.store.create.success", {
      requestId,
      fileSearchStoreName: store.name,
      displayName: store.displayName || displayName || null,
    });

    return res.status(201).json({
      fileSearchStoreName: store.name,
      displayName: store.displayName || displayName || null,
    });
  } catch (error) {
    logger.error("file_search.store.create.failed", {
      requestId,
      error: error.message,
    });

    return res.status(500).json({
      error: error.message || "Failed to create file search store.",
    });
  }
});

app.get("/api/file-search/stores", async (req, res) => {
  const requestId = req.requestId || null;

  try {
    const limit = req.query?.limit;
    const stores = await listFileSearchStores({ limit });

    logger.info("file_search.store.list.success", {
      requestId,
      count: stores.length,
    });

    return res.json({
      stores,
    });
  } catch (error) {
    logger.error("file_search.store.list.failed", {
      requestId,
      error: error.message,
    });

    return res.status(500).json({
      error: error.message || "Failed to list file search stores.",
    });
  }
});

app.post("/api/file-search/upload", upload.single("file"), async (req, res) => {
  const requestId = req.requestId || null;
  const uploadedFile = req.file;

  try {
    const fileSearchStoreName = String(req.body?.fileSearchStoreName || "").trim();
    const displayName = String(req.body?.displayName || uploadedFile?.originalname || "").trim();

    logger.info("file_search.upload.start", {
      requestId,
      fileSearchStoreName: fileSearchStoreName || null,
      fileName: uploadedFile?.originalname || null,
      mimeType: uploadedFile?.mimetype || null,
      sizeBytes: uploadedFile?.size || null,
    });

    if (!uploadedFile) {
      logger.warn("file_search.upload.validation_failed", {
        requestId,
        reason: "File is required.",
      });

      return res.status(400).json({ error: "File is required." });
    }

    if (!fileSearchStoreName) {
      logger.warn("file_search.upload.validation_failed", {
        requestId,
        reason: "fileSearchStoreName is required.",
      });

      return res
        .status(400)
        .json({ error: "fileSearchStoreName is required to upload files." });
    }

    await uploadFileToStore({
      filePath: uploadedFile.path,
      fileSearchStoreName,
      displayName,
      mimeType: normalizeUploadMimeType(uploadedFile),
      waitForCompletion: false,
    });

    try {
      await upsertFileSearchStore({
        fileSearchStoreName,
        lastUploadedFileName: uploadedFile.originalname,
      });
    } catch (historyError) {
      logger.warn("file_search.upload.history_upsert_failed", {
        requestId,
        fileSearchStoreName,
        error: historyError.message,
      });
    }

    logger.info("file_search.upload.accepted", {
      requestId,
      fileSearchStoreName,
      fileName: uploadedFile.originalname,
      processingStarted: true,
    });

    return res.status(202).json({
      uploaded: true,
      processingStarted: true,
      message: `File uploaded. Processing has started for ${uploadedFile.originalname}. You can start chatting now.`,
      fileName: uploadedFile.originalname,
      fileSearchStoreName,
    });
  } catch (error) {
    logger.error("file_search.upload.failed", {
      requestId,
      fileSearchStoreName: req.body?.fileSearchStoreName || null,
      fileName: uploadedFile?.originalname || null,
      error: error.message,
    });

    return res.status(500).json({
      error: error.message || "Failed to upload file to file search store.",
    });
  } finally {
    if (uploadedFile?.path) {
      logger.info("file_search.upload.temp_file_cleanup", {
        requestId,
        tempPath: uploadedFile.path,
      });
      fsPromises.rm(uploadedFile.path, { force: true }).catch(() => {});
    }
  }
});

app.post("/api/suggestions", async (req, res) => {
  const requestId = req.requestId || null;

  try {
    const fileSearchStoreName = String(req.body?.fileSearchStoreName || "").trim();
    const sourceLinks = parseLinks(req.body?.sourceLinks);

    logger.info("suggestions.request.start", {
      requestId,
      fileSearchStoreName: fileSearchStoreName || null,
      sourceLinkCount: sourceLinks.length,
    });

    const questions = await generateSuggestedQuestions({
      fileSearchStoreName,
      sourceLinks,
    });

    if (fileSearchStoreName) {
      try {
        await upsertFileSearchStore({
          fileSearchStoreName,
          queryIncrement: 0,
          suggestionIncrement: 1,
        });
      } catch (historyError) {
        logger.warn("suggestions.history_upsert_failed", {
          requestId,
          fileSearchStoreName,
          error: historyError.message,
        });
      }
    }

    logger.info("suggestions.request.success", {
      requestId,
      fileSearchStoreName: fileSearchStoreName || null,
      questionCount: questions.length,
    });

    return res.json({
      questions,
    });
  } catch (error) {
    logger.error("suggestions.request.failed", {
      requestId,
      error: error.message,
    });

    return res.status(500).json({
      error: error.message || "Failed to generate suggested questions.",
    });
  }
});

app.post("/api/chat", async (req, res) => {
  const requestId = req.requestId || null;

  try {
    const message = String(req.body?.message || "").trim();
    const sessionId = String(req.body?.sessionId || randomUUID());
    const fileSearchStoreName = String(req.body?.fileSearchStoreName || "").trim();

    const theoreticalData = parseOptionalData(req.body?.theoreticalData, "theoreticalData");
    const actualData = parseOptionalData(req.body?.actualData, "actualData");
    const sourceLinks = parseLinks(req.body?.sourceLinks);
    const hasComparisonPayload = theoreticalData != null && actualData != null;

    logger.info("chat.request.start", {
      requestId,
      sessionId,
      hasMessage: Boolean(message),
      messageLength: message.length,
      hasComparisonPayload,
      sourceLinkCount: sourceLinks.length,
      fileSearchStoreName: fileSearchStoreName || null,
    });

    if (!message && !hasComparisonPayload) {
      logger.warn("chat.request.validation_failed", {
        requestId,
        sessionId,
        reason: "Missing message and missing comparison payload.",
      });

      return res.status(400).json({
        error: "Send a message or provide both theoreticalData and actualData.",
      });
    }

    let reply;
    let mode;
    let comparison = null;

    if (hasComparisonPayload) {
      const report = buildDeterministicReport({
        message,
        theoreticalData,
        actualData,
        sourceLinks,
      });

      logger.info("chat.request.deterministic_report_created", {
        requestId,
        sessionId,
        metricCount: report.rows.length,
      });

      reply = report.report;
      mode = "deterministic-comparison";
      comparison = {
        rows: report.rows,
        summary: report.summary,
      };
    } else {
      logger.info("chat.request.llm_generation_start", {
        requestId,
        sessionId,
        fileSearchEnabled: Boolean(fileSearchStoreName),
      });

      const generated = await generateAnswerWithFileSearch({
        prompt: message,
        fileSearchStoreName,
        sourceLinks,
      });

      reply = appendSourcesSection(generated.text, sourceLinks);
      mode = "llm-factual-mode";

      logger.info("chat.request.llm_generation_success", {
        requestId,
        sessionId,
        replyLength: reply.length,
      });
    }

    const persistence = await saveChatExchange({
      sessionId,
      userMessage: message || "[comparison request]",
      assistantMessage: reply,
      sourceLinks,
      fileSearchStoreName,
    });

    if (fileSearchStoreName) {
      try {
        await upsertFileSearchStore({
          fileSearchStoreName,
          queryIncrement: 1,
        });
      } catch (historyError) {
        logger.warn("chat.request.history_upsert_failed", {
          requestId,
          sessionId,
          fileSearchStoreName,
          error: historyError.message,
        });
      }
    }

    if (persistence.saved) {
      logger.info("chat.request.persistence_saved", {
        requestId,
        sessionId,
      });
    } else {
      logger.warn("chat.request.persistence_failed", {
        requestId,
        sessionId,
        reason: persistence.reason || "unknown",
      });
    }

    logger.info("chat.request.success", {
      requestId,
      sessionId,
      mode,
      sourceLinkCount: sourceLinks.length,
    });

    return res.json({
      sessionId,
      mode,
      reply,
      comparison,
      sourceLinks,
      persistence,
    });
  } catch (error) {
    logger.error("chat.request.failed", {
      requestId,
      error: error.message,
    });

    return res.status(400).json({
      error: error.message || "Failed to process chat request.",
    });
  }
});

const clientDist = path.join(__dirname, "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));

  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }

    return res.sendFile(path.join(clientDist, "index.html"));
  });
}

async function startServer() {
  await fsPromises.mkdir(UPLOAD_DIR, { recursive: true });

  app.listen(PORT, () => {
    logger.info("server.started", {
      port: PORT,
      url: `http://localhost:${PORT}`,
      uploadMaxMb: FILE_UPLOAD_MAX_MB,
    });
  });
}

startServer().catch((error) => {
  logger.error("server.start_failed", {
    error: error.message,
  });
  process.exit(1);
});

app.use((error, req, res, _next) => {
  const requestId = req?.requestId || null;

  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    logger.warn("upload.middleware.limit_file_size", {
      requestId,
      error: error.message,
      uploadMaxMb: FILE_UPLOAD_MAX_MB,
    });

    return res.status(413).json({
      error: `File too large. Max supported size is ${FILE_UPLOAD_MAX_MB}MB.`,
    });
  }

  if (error instanceof multer.MulterError) {
    logger.warn("upload.middleware.multer_error", {
      requestId,
      error: error.message,
      code: error.code,
    });

    return res.status(400).json({
      error: `Upload failed: ${error.message}`,
    });
  }

  if (error instanceof Error) {
    logger.error("server.unhandled_error", {
      requestId,
      error: error.message,
    });

    return res.status(500).json({
      error: error.message,
    });
  }

  logger.error("server.unexpected_error_shape", {
    requestId,
  });

  return res.status(500).json({
    error: "Unexpected upload error.",
  });
});
