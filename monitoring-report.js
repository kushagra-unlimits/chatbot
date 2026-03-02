function parseJsonDataset(input, label) {
  if (input == null || input === "") {
    return null;
  }

  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch (error) {
      throw new Error(`${label} must be valid JSON.`);
    }
  }

  if (typeof input === "object") {
    return input;
  }

  throw new Error(`${label} must be an object, array, or JSON string.`);
}

function toMetricRows(dataset, datasetLabel) {
  if (dataset == null) {
    return new Map();
  }

  const rows = new Map();

  if (Array.isArray(dataset)) {
    for (const item of dataset) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const metricName = String(item.metric ?? item.name ?? "").trim();
      if (!metricName) {
        continue;
      }

      const rawValue = item.value ?? item.actual ?? item.theoretical;
      const numericValue = Number(rawValue);

      rows.set(metricName, {
        metric: metricName,
        rawValue,
        numericValue: Number.isFinite(numericValue) ? numericValue : null,
        datasetLabel,
      });
    }

    return rows;
  }

  if (typeof dataset === "object") {
    for (const [metric, rawValue] of Object.entries(dataset)) {
      const metricName = String(metric).trim();
      if (!metricName) {
        continue;
      }

      const numericValue = Number(rawValue);
      rows.set(metricName, {
        metric: metricName,
        rawValue,
        numericValue: Number.isFinite(numericValue) ? numericValue : null,
        datasetLabel,
      });
    }

    return rows;
  }

  throw new Error(`${datasetLabel} must be an object or array.`);
}

function formatValue(rawValue, numericValue) {
  if (rawValue == null || rawValue === "") {
    return "N/A";
  }

  if (numericValue == null) {
    return String(rawValue);
  }

  return Number.isInteger(numericValue)
    ? String(numericValue)
    : numericValue.toFixed(6).replace(/\.?0+$/, "");
}

function formatDelta(value) {
  if (value == null) {
    return "N/A";
  }

  const formatted = Number.isInteger(value)
    ? String(value)
    : value.toFixed(6).replace(/\.?0+$/, "");

  return value > 0 ? `+${formatted}` : formatted;
}

function formatPercent(value) {
  if (value == null) {
    return "N/A";
  }

  const formatted = value.toFixed(4).replace(/\.?0+$/, "");
  return `${value > 0 ? "+" : ""}${formatted}%`;
}

function compareDatasets(theoreticalInput, actualInput) {
  const theoreticalParsed = parseJsonDataset(theoreticalInput, "theoreticalData");
  const actualParsed = parseJsonDataset(actualInput, "actualData");

  const theoreticalRows = toMetricRows(theoreticalParsed, "theoreticalData");
  const actualRows = toMetricRows(actualParsed, "actualData");

  const metrics = new Set([...theoreticalRows.keys(), ...actualRows.keys()]);
  const reportRows = [];

  for (const metric of metrics) {
    const theoretical = theoreticalRows.get(metric);
    const actual = actualRows.get(metric);

    const theoreticalNumeric = theoretical?.numericValue ?? null;
    const actualNumeric = actual?.numericValue ?? null;

    let delta = null;
    let deltaPercent = null;
    let status = "insufficient-data";

    if (theoreticalNumeric != null && actualNumeric != null) {
      delta = actualNumeric - theoreticalNumeric;

      if (theoreticalNumeric !== 0) {
        deltaPercent = (delta / theoreticalNumeric) * 100;
      }

      if (delta === 0) {
        status = "matched";
      } else if (delta > 0) {
        status = "actual-above-theoretical";
      } else {
        status = "actual-below-theoretical";
      }
    }

    reportRows.push({
      metric,
      theoreticalValue: formatValue(theoretical?.rawValue, theoreticalNumeric),
      actualValue: formatValue(actual?.rawValue, actualNumeric),
      delta: formatDelta(delta),
      deltaPercent: formatPercent(deltaPercent),
      status,
      deltaRaw: delta,
      deltaPercentRaw: deltaPercent,
    });
  }

  return reportRows;
}

function buildSummary(rows) {
  let matched = 0;
  let above = 0;
  let below = 0;
  let insufficient = 0;

  const absPercentValues = [];

  for (const row of rows) {
    if (row.status === "matched") {
      matched += 1;
    } else if (row.status === "actual-above-theoretical") {
      above += 1;
    } else if (row.status === "actual-below-theoretical") {
      below += 1;
    } else {
      insufficient += 1;
    }

    if (typeof row.deltaPercentRaw === "number") {
      absPercentValues.push(Math.abs(row.deltaPercentRaw));
    }
  }

  const meanAbsolutePercentError =
    absPercentValues.length > 0
      ? absPercentValues.reduce((sum, value) => sum + value, 0) / absPercentValues.length
      : null;

  return {
    totalMetrics: rows.length,
    matched,
    above,
    below,
    insufficient,
    meanAbsolutePercentError,
  };
}

function normalizeSourceLinks(sourceLinksInput) {
  const values = Array.isArray(sourceLinksInput)
    ? sourceLinksInput
    : typeof sourceLinksInput === "string"
      ? sourceLinksInput.split(/\r?\n|,/g)
      : [];

  const links = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = new URL(trimmed);
      links.push(parsed.toString());
    } catch {
      throw new Error(`Invalid source link: ${trimmed}`);
    }
  }

  return links;
}

function buildDeterministicReport({ message, theoreticalData, actualData, sourceLinks }) {
  const rows = compareDatasets(theoreticalData, actualData);
  const summary = buildSummary(rows);
  const promptLine = message ? `\nQuestion context: ${message.trim()}\n` : "\n";

  const tableHeader = [
    "| Metric | Theoretical | Actual | Delta (Actual - Theoretical) | Delta % | Status |",
    "|---|---:|---:|---:|---:|---|",
  ];

  const tableRows = rows.map(
    (row) =>
      `| ${row.metric} | ${row.theoreticalValue} | ${row.actualValue} | ${row.delta} | ${row.deltaPercent} | ${row.status} |`,
  );

  const mape =
    summary.meanAbsolutePercentError == null
      ? "N/A"
      : `${summary.meanAbsolutePercentError.toFixed(4).replace(/\.?0+$/, "")}%`;

  const summaryLines = [
    `- Total metrics compared: ${summary.totalMetrics}`,
    `- Matched: ${summary.matched}`,
    `- Actual above theoretical: ${summary.above}`,
    `- Actual below theoretical: ${summary.below}`,
    `- Insufficient data: ${summary.insufficient}`,
    `- Mean absolute percentage error (MAPE): ${mape}`,
  ];

  const sourceLines =
    sourceLinks.length > 0
      ? sourceLinks.map((link) => `- ${link}`)
      : ["- No external source links were provided for this deterministic comparison request."];

  const report = [
    "Verified Realtime Monitoring Comparison Report",
    promptLine,
    ...tableHeader,
    ...tableRows,
    "",
    "Summary",
    ...summaryLines,
    "",
    "Sources",
    ...sourceLines,
    "",
    "Data Integrity Notes",
    "- Values above are computed directly from submitted theoreticalData and actualData.",
    sourceLinks.length > 0
      ? "- Source links are listed exactly as provided."
      : "- This report used only provided theoreticalData and actualData (no external links).",
    "- No additional or inferred data was added.",
  ].join("\n");

  return {
    report,
    summary,
    rows,
  };
}

module.exports = {
  buildDeterministicReport,
  normalizeSourceLinks,
};
