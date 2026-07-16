import { fork } from "child_process";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { finished } from "stream/promises";
import JSZip from "jszip";
import sql from "mssql";

let supabaseClient = null;
let realtimeWorker = null;
let realtimeWorkerRestartTimeout = null;
let realtimeStatus = "DISCONNECTED";
let automaticSupportAlertDebounceTimeout = null;
let automaticSupportAlertRunning = false;
let automaticSupportAlertReviewInterval = null;
let automaticSupportAlertLastReviewedAtIso = new Date(Date.now() - 15000).toISOString();
const clients = new Set();
const voucherExportJobs = new Map();
let envLoaded = false;
let sqlServerPool = null;
let sqlServerPoolSignature = null;
const QUERY_LOGGING_ENABLED = process.env.LOG_QUERIES !== "false";
const AUTOMATIC_SUPPORT_ALERT_THRESHOLD = 4;
const AUTOMATIC_SUPPORT_ALERT_REVIEW_INTERVAL_MS = 15_000;
const AUTOMATIC_SUPPORT_ALERT_DEBOUNCE_MS = 1_000;
const AUTOMATIC_SUPPORT_ALERT_SOURCE = "workload-auto";
const AUTOMATIC_SUPPORT_ALERT_BOT_ID = "system-bot";
const AUTOMATIC_SUPPORT_ALERT_BOT_NAME = "BOT";
const AUTOMATIC_SUPPORT_ALERT_BOT_ROLE = "bot";
const YCLOUD_API_BASE_URL = "https://api.ycloud.com/v2";
const YCLOUD_SEND_URL = `${YCLOUD_API_BASE_URL}/whatsapp/messages/sendDirectly`;
const YCLOUD_MESSAGES_URL = `${YCLOUD_API_BASE_URL}/whatsapp/messages`;
const YCLOUD_BALANCE_URL = `${YCLOUD_API_BASE_URL}/balance`;

function normalizeYCloudPhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let cleaned = raw.replace(/[\s\-\(\)]/g, "");
  if (cleaned.startsWith("00")) {
    cleaned = `+${cleaned.slice(2)}`;
  } else if (!cleaned.startsWith("+")) {
    cleaned = `+${cleaned.replace(/[^\d]/g, "")}`;
  }

  return cleaned;
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  const configuredOrigin = process.env.CORS_ORIGIN;

  if (configuredOrigin) {
    return configuredOrigin;
  }

  if (origin) {
    return origin;
  }

  return "*";
}

function applyApiCors(req, res) {
  const allowedOrigin = getAllowedOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Cache-Control, Pragma, X-Requested-With"
  );
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Vary", "Origin");
}

function queryPreview(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return { rows: value.length };
  if (typeof value === "object") {
    const summary = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "data" && Array.isArray(entry)) {
        summary.rows = entry.length;
      } else if (key === "error" && entry) {
        summary.error = entry.message || String(entry);
      } else if (["count", "status", "statusText"].includes(key)) {
        summary[key] = entry;
      }
    }
    return summary;
  }
  return value;
}

function redactSensitiveBody(body) {
  if (!body || typeof body !== "object") {
    return body;
  }

  const clone = Array.isArray(body) ? [...body] : { ...body };
  for (const key of ["api_key", "access_token", "token", "authorization"]) {
    if (key in clone) {
      clone[key] = "[redacted]";
    }
  }
  return clone;
}

function getRequestLogPrefix(req) {
  return String(req?.originalUrl || req?.path || "").startsWith("/api/ycloud") ? "[YCLOUD]" : "[API]";
}

function extractGoogleDriveFileId(value) {
  if (!value) return null;

  const text = String(value);
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function buildVoucherFetchCandidates(sourceUrl) {
  const url = String(sourceUrl || "").trim();
  if (!url) return [];

  const candidates = [];
  const driveFileId = extractGoogleDriveFileId(url);

  if (driveFileId) {
    candidates.push(`https://drive.google.com/uc?export=download&id=${driveFileId}`);
    candidates.push(`https://drive.usercontent.google.com/download?id=${driveFileId}&export=download&authuser=0`);
    candidates.push(`https://drive.google.com/uc?export=view&id=${driveFileId}`);
    candidates.push(`https://drive.google.com/file/d/${driveFileId}/preview`);
  }

  candidates.push(url);
  return [...new Set(candidates)];
}

function extractGoogleDriveConfirmUrl(html, fallbackFileId) {
  const text = String(html || "");
  const patterns = [
    /href="([^"]*\/uc\?export=download[^"]+)"/i,
    /href='([^']*\/uc\?export=download[^']+)'/i,
    /window\.location\.href\s*=\s*"([^"]*\/uc\?export=download[^"]+)"/i,
    /window\.location\.href\s*=\s*'([^']*\/uc\?export=download[^']+)'/i,
    /confirm=([a-zA-Z0-9_-]+)/i,
  ];

  let confirmToken = null;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      if (match[1].includes("/uc?export=download")) {
        return match[1].replace(/&amp;/g, "&");
      }
      if (pattern.source.includes("confirm=")) {
        confirmToken = match[1];
      }
    }
  }

  if (confirmToken && fallbackFileId) {
    return `https://drive.google.com/uc?export=download&confirm=${confirmToken}&id=${fallbackFileId}`;
  }

  return null;
}

function sanitizeFilenamePart(value, fallback = "voucher") {
  const text = String(value || fallback).trim();
  const sanitized = text.replace(/[\/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_");
  return sanitized || fallback;
}

function parseDataUrlImage(dataUrl) {
  const raw = String(dataUrl || "").trim();
  if (!raw) return null;

  const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;

  const mimeType = match[1] || "image/png";
  const base64 = match[2] || "";
  if (!base64) return null;

  return {
    mimeType,
    buffer: Buffer.from(base64, "base64"),
    extension: guessExtensionFromMimeType(mimeType, "png"),
  };
}

async function uploadDepositCroppedImageToStorage(
  client,
  dataUrl,
  { depositId = "", numeroOperacion = "", fileName = "" } = {},
) {
  const parsed = parseDataUrlImage(dataUrl);
  if (!client || !parsed?.buffer?.length) return null;

  const baseName = sanitizeFilenamePart(
    fileName || numeroOperacion || depositId || "imagen_recortada",
    "imagen_recortada",
  );
  const storagePath = `depositos-regularizados/${Date.now()}-${baseName}.${parsed.extension}`;

  const { error: uploadError } = await client.storage.from(WHATSAPP_MEDIA_BUCKET).upload(storagePath, parsed.buffer, {
    contentType: parsed.mimeType,
    upsert: true,
  });

  if (uploadError) {
    throw uploadError;
  }

  const { data: publicUrlData } = client.storage.from(WHATSAPP_MEDIA_BUCKET).getPublicUrl(storagePath);

  return {
    bucket: WHATSAPP_MEDIA_BUCKET,
    path: storagePath,
    publicUrl: publicUrlData?.publicUrl || null,
    contentType: parsed.mimeType,
  };
}

function formatDateForDisplay(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function buildDepositSearchBlob(deposit) {
  return [
    deposit?.empresa?.nombre,
    deposit?.sucursal?.nombre,
    deposit?.trabajador?.nombre,
    deposit?.anexo,
    deposit?.monto != null ? String(deposit.monto) : "",
    deposit?.numero_operacion,
    deposit?.estado ? String(deposit.estado).replaceAll("_", " ") : "",
    deposit?.ruc_cliente,
    formatDateForDisplay(deposit?.fecha_deposito),
    formatDateForDisplay(deposit?.fecha_registro),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function chunkArray(values, chunkSize = 100) {
  const chunks = [];
  if (!Array.isArray(values) || values.length === 0) return chunks;

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

function resolveVoucherExportPeriod({ exportMode, specificDate, filterPeriod, selectedMonth }) {
  if (exportMode === "date") {
    return { date: specificDate || null, period: null };
  }

  if (exportMode === "month") {
    const now = new Date();
    const monthValue = selectedMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return { date: null, period: `month:${monthValue}` };
  }

  if (specificDate) {
    return { date: specificDate, period: null };
  }

  if (filterPeriod === "month") {
    const now = new Date();
    const monthValue = selectedMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return { date: null, period: `month:${monthValue}` };
  }

  if (filterPeriod && filterPeriod !== "all") {
    return { date: null, period: filterPeriod };
  }

  return { date: null, period: null };
}

function inferVoucherExtension(contentType, sourceUrl) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("pdf")) return "pdf";
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";

  const urlExtMatch = String(sourceUrl || "").match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
  if (urlExtMatch?.[1]) {
    return urlExtMatch[1].toLowerCase().replace("jpeg", "jpg");
  }

  return "bin";
}

function createVoucherExportJobSnapshot(job) {
  if (!job) return null;

  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    total: job.total,
    processed: job.processed,
    filesAdded: job.filesAdded,
    failures: job.failures,
    error: job.error,
    filters: job.filters || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    zipSizeBytes: job.zipSizeBytes || null,
    zipFilename: job.zipFilename || null,
    createdBy: job.createdBy || null,
  };
}

async function fetchVoucherExportJobRow(jobId) {
  return voucherExportJobs.get(jobId) || null;
}

async function fetchVoucherExportJobRows(limit = 25) {
  return Array.from(voucherExportJobs.values())
    .map(createVoucherExportJobSnapshot)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit)
    .filter(Boolean);
}

function toNodeReadable(body) {
  if (!body) return null;
  if (typeof body.pipe === "function") return body;
  if (typeof body.getReader === "function") return Readable.fromWeb(body);
  return null;
}

async function fetchVoucherReadableStream(sourceUrl) {
  const candidates = buildVoucherFetchCandidates(sourceUrl);
  let lastError = null;
  const driveFileId = extractGoogleDriveFileId(sourceUrl);

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: "GET",
        redirect: "follow",
      });

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} al descargar voucher`);
        continue;
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const isHtml = contentType.toLowerCase().includes("text/html");

      if (isHtml) {
        const html = await response.text();
        const confirmUrl = extractGoogleDriveConfirmUrl(html, driveFileId);
        if (confirmUrl && confirmUrl !== candidate) {
          const confirmResponse = await fetch(confirmUrl, {
            method: "GET",
            redirect: "follow",
          });

          if (confirmResponse.ok) {
            const confirmContentType = confirmResponse.headers.get("content-type") || "application/octet-stream";
            const confirmStream = toNodeReadable(confirmResponse.body);
            if (confirmStream) {
              return {
                stream: confirmStream,
                contentType: confirmContentType,
                sourceUrl: confirmUrl,
              };
            }
          }
        }

        lastError = new Error(`Respuesta HTML no descargable desde ${candidate}`);
        continue;
      }

      const stream = toNodeReadable(response.body);
      if (!stream) {
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          stream: Readable.from(buffer),
          contentType,
          sourceUrl: candidate,
        };
      }

      return {
        stream,
        contentType,
        sourceUrl: candidate,
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error("No se pudo descargar el voucher");
}

async function queueVoucherExportJob(filters, createdBy = null) {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const queuedJob = {
    id: jobId,
    status: "queued",
    progress: 0,
    total: 0,
    processed: 0,
    filesAdded: 0,
    failures: [],
    error: null,
    filters: {
      ids: Array.isArray(filters?.ids) ? filters.ids : [],
      exportMode: filters?.exportMode || null,
      specificDate: filters?.specificDate || null,
      filterPeriod: filters?.filterPeriod || "all",
      selectedMonth: filters?.selectedMonth || null,
      searchTerm: filters?.searchTerm || "",
      filterStatus: filters?.filterStatus || "all",
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    zipSizeBytes: null,
    zipFilename: "vouchers_depositos.zip",
    createdBy,
  };

  voucherExportJobs.set(jobId, queuedJob);

  console.info("[API] voucher export job queued", {
    jobId,
    filterSummary: {
      exportMode: queuedJob.filters.exportMode,
      filterPeriod: queuedJob.filters.filterPeriod,
      selectedMonth: queuedJob.filters.selectedMonth,
      specificDate: queuedJob.filters.specificDate,
      filterStatus: queuedJob.filters.filterStatus,
    },
  });

  setImmediate(() => {
    void runVoucherExportJob(jobId, queuedJob.filters).catch((error) => {
      console.error("[API] ERROR voucher export job run", {
        jobId,
        message: error.message,
      });
    });
  });
  return queuedJob;
}

function updateVoucherExportJob(jobId, patch) {
  const job = voucherExportJobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  voucherExportJobs.set(jobId, job);
  return job;
}

function getVoucherExportProgress(vouchersLength, processed) {
  if (!vouchersLength) return 100;
  return Math.min(92, 5 + Math.round((processed / vouchersLength) * 87));
}

async function exportVouchersToZip(vouchers, { jobId = null } = {}) {
  const failures = [];
  let filesAdded = 0;
  let processed = 0;
  const totalVouchers = vouchers.length || 0;
  const progressStep = totalVouchers <= 25 ? 1 : totalVouchers <= 100 ? 5 : totalVouchers <= 1000 ? 25 : 100;
  let nextProgressLog = progressStep;
  let lastCompletedItem = null;
  const zip = new JSZip();

  console.info("[API] Voucher export started", {
    total: totalVouchers,
    progressStep,
    inMemory: true,
  });

  const downloadTasks = vouchers.map(async (deposit) => {
    try {
      const binary = await fetchVoucherBinary(deposit.imagen_voucher);
      return {
        ok: true,
        deposit,
        ...binary,
      };
    } catch (error) {
      return {
        ok: false,
        deposit,
        error,
      };
    }
  });

  const settledDownloads = await Promise.all(downloadTasks);

  for (const result of settledDownloads) {
    processed += 1;

    if (result.ok) {
      const { deposit, buffer, contentType, sourceUrl } = result;
      const formattedDate = deposit.fecha_registro || deposit.fecha_deposito
        ? String(deposit.fecha_registro || deposit.fecha_deposito).split("T")[0]
        : "sin-fecha";
      const sucursalFolder = sanitizeFilenamePart(deposit.sucursal?.nombre, "sin-sucursal");
      const extension = inferVoucherExtension(contentType, sourceUrl || deposit.imagen_voucher);
      const opNumber = sanitizeFilenamePart(deposit.numero_operacion, `op_${deposit.id}`);
      const filename = `op_${opNumber}_id_${sanitizeFilenamePart(deposit.id, "id")}.${extension}`;
      const entryPath = `${formattedDate}/${sucursalFolder}/${filename}`;

      zip.file(entryPath, buffer);
      filesAdded += 1;
      lastCompletedItem = {
        id: deposit.id,
        numero_operacion: deposit.numero_operacion,
        sucursal: deposit.sucursal?.nombre || null,
        sourceUrl,
        filename,
      };
    } else {
      failures.push({
        id: result.deposit.id,
        numero_operacion: result.deposit.numero_operacion,
        error: result.error?.message || "No se pudo descargar el voucher",
      });
      console.error("[API] Voucher export item failed", {
        id: result.deposit.id,
        numero_operacion: result.deposit.numero_operacion,
        error: result.error?.message || "No se pudo descargar el voucher",
      });
    }

    if (processed >= nextProgressLog || processed === totalVouchers) {
      console.info("[API] Voucher export progress", {
        processed,
        total: totalVouchers,
        filesAdded,
        failures: failures.length,
        progress: getVoucherExportProgress(totalVouchers, processed),
        lastCompletedItem,
      });
      while (nextProgressLog <= processed) {
        nextProgressLog += progressStep;
      }
    }

    if (jobId) {
      updateVoucherExportJob(jobId, {
        processed,
        filesAdded,
        failures,
        progress: getVoucherExportProgress(vouchers.length, processed),
      });
    }
  }

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  const zipSizeBytes = zipBuffer.length;

  console.info("[API] Voucher export finished", {
    total: totalVouchers,
    processed,
    filesAdded,
    failures: failures.length,
    zipSizeBytes,
  });

  return { zipBuffer, zipSizeBytes, filesAdded, failures, processed };
}

async function fetchVoucherBinary(sourceUrl) {
  const candidates = buildVoucherFetchCandidates(sourceUrl);
  let lastError = null;
  const driveFileId = extractGoogleDriveFileId(sourceUrl);

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: "GET",
        redirect: "follow",
      });

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} al descargar voucher`);
        continue;
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const isHtml = contentType.toLowerCase().includes("text/html");

      if (isHtml) {
        const html = await response.text();
        const confirmUrl = extractGoogleDriveConfirmUrl(html, driveFileId);
        if (confirmUrl && confirmUrl !== candidate) {
          const confirmResponse = await fetch(confirmUrl, {
            method: "GET",
            redirect: "follow",
          });

          if (confirmResponse.ok) {
            const confirmContentType = confirmResponse.headers.get("content-type") || "application/octet-stream";
            const confirmBuffer = Buffer.from(await confirmResponse.arrayBuffer());
            return {
              buffer: confirmBuffer,
              contentType: confirmContentType,
              sourceUrl: confirmUrl,
            };
          }
        }

        if (candidate !== candidates[candidates.length - 1]) {
          lastError = new Error(`Respuesta HTML no descargable desde ${candidate}`);
          continue;
        }
      }

      const arrayBuffer = isHtml ? Buffer.from(html || "", "utf8") : Buffer.from(await response.arrayBuffer());
      return {
        buffer: arrayBuffer,
        contentType,
        sourceUrl: candidate,
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error("No se pudo descargar el voucher");
}

async function fetchDepositsForVoucherExport(filters = {}) {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase no estÃ¡ configurado en el backend");
  }

  const { ids, exportMode, specificDate, filterPeriod, selectedMonth, searchTerm, filterStatus } = filters;
  const search = String(searchTerm || "").trim().toLowerCase();
  const status = String(filterStatus || "all").trim();

  if (Array.isArray(ids) && ids.length > 0) {
    const uniqueIds = [...new Set(ids.map((value) => String(value).trim()).filter(Boolean))];
    const chunks = chunkArray(uniqueIds, 100);
    const results = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkQuery = client
        .from("depositos")
        .select(
          `id, numero_operacion, cliente, monto, fecha_registro, fecha_solo_date, imagen_voucher, anexo, numero_operacion_banco, fecha_deposito, estado, observaciones, motivo_rechazo, fecha_validacion, referencia_cliente, validado_por, moneda, ruc_cliente, telefono_origen, chatwoot_message_id, es_antiguo,
  empresa:empresa_id (id, nombre, estado, abreviatura),
  banco:banco_id (id, abreviatura, estado),
  sucursal:sucursal_id (id, nombre),
  trabajador:trabajador_sucursal_id (id, nombre, telefono_origen),
  validado_por_usuario:validado_por (id, nombre)`
        )
        .in("id", chunk)
        .order("fecha_registro", { ascending: false });

      const { data, error } = await runLoggedQuery(
        "depositos.byIds.chunk",
        { chunkIndex: index, chunkSize: chunk.length, totalIds: uniqueIds.length },
        () => chunkQuery
      );

      if (error) throw new Error(error.message);
      if (Array.isArray(data) && data.length > 0) {
        results.push(...data);
      }
    }

    results.sort((a, b) => {
      const aTime = new Date(a.fecha_registro || a.fecha_solo_date || 0).getTime();
      const bTime = new Date(b.fecha_registro || b.fecha_solo_date || 0).getTime();
      return bTime - aTime;
    });

    return results;
  }

  const { date, period } = resolveVoucherExportPeriod({
    exportMode,
    specificDate,
    filterPeriod,
    selectedMonth,
  });

  let deposits = [];

  if (date || period) {
    deposits = await fetchDeposits({
      date: date || undefined,
      period: period || undefined,
      limit: 5000,
    });
  } else {
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error } = await runLoggedQuery(
        "depositos.export.all.page",
        { page, from, to },
        () =>
          client
            .from("depositos")
            .select(
            `id, numero_operacion, cliente, monto, fecha_registro, fecha_solo_date, imagen_voucher, anexo, numero_operacion_banco, fecha_deposito, estado, observaciones, motivo_rechazo, fecha_validacion, referencia_cliente, validado_por, moneda, ruc_cliente, telefono_origen, chatwoot_message_id, es_antiguo,
  empresa:empresa_id (id, nombre, estado, abreviatura),
  banco:banco_id (id, abreviatura, estado),
  sucursal:sucursal_id (id, nombre),
  trabajador:trabajador_sucursal_id (id, nombre, telefono_origen),
  validado_por_usuario:validado_por (id, nombre)`
            )
            .order("fecha_registro", { ascending: false })
            .range(from, to)
      );

      if (error) throw new Error(error.message);
      deposits = deposits.concat(data || []);
      hasMore = Array.isArray(data) && data.length === pageSize;
      page += 1;
      if (page >= 50) hasMore = false;
    }
  }

  let filtered = deposits.filter((deposit) => deposit.imagen_voucher);

  if (status !== "all") {
    filtered = filtered.filter((deposit) => String(deposit.estado || "") === status);
  }

  if (search) {
    filtered = filtered.filter((deposit) => buildDepositSearchBlob(deposit).includes(search));
  }

  return filtered;
}

async function runVoucherExportJob(jobId, filters) {
  const job = updateVoucherExportJob(jobId, {
    status: "processing",
    progress: 1,
    error: null,
    failures: [],
    processed: 0,
    filesAdded: 0,
    total: 0,
  });

  let exportResult = null;
  try {
    const deposits = await fetchDepositsForVoucherExport(filters);

    const vouchers = (deposits || []).filter((deposit) => deposit.imagen_voucher);
    updateVoucherExportJob(jobId, {
      total: vouchers.length,
      progress: vouchers.length === 0 ? 100 : 5,
    });

    exportResult = await exportVouchersToZip(vouchers, {
      jobId,
    });
    const { zipSizeBytes, filesAdded, failures } = exportResult;

    if (filesAdded === 0) {
      updateVoucherExportJob(jobId, {
        status: "error",
        progress: 100,
        error: "No se pudo descargar ningÃºn voucher para exportar",
        failures,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    updateVoucherExportJob(jobId, { progress: 95 });
    updateVoucherExportJob(jobId, {
      status: "completed",
      progress: 100,
      filesAdded,
      failures,
      zipBuffer: exportResult.zipBuffer,
      zipSizeBytes: zipSizeBytes || exportResult.zipBuffer.length,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[API] ERROR export job", { jobId, message: error.message, stack: error.stack });
    updateVoucherExportJob(jobId, {
      status: "error",
      progress: 100,
      error: error.message,
      completedAt: new Date().toISOString(),
    });
  } finally {}
}

async function runLoggedQuery(label, details, executor) {
  const startedAt = Date.now();
  const queryPrefix = String(label || "").startsWith("whatsapp.") || String(label || "").startsWith("ycloud.")
    ? "[YCLOUD]"
    : "[DB]";
  if (QUERY_LOGGING_ENABLED) {
    console.log(`${queryPrefix} START ${label}`, details || {});
  }

  try {
    const result = await executor();
    if (QUERY_LOGGING_ENABLED) {
      console.log(`${queryPrefix} OK ${label} (${Date.now() - startedAt}ms)`, queryPreview(result));
    }
    return result;
  } catch (error) {
    if (QUERY_LOGGING_ENABLED) {
      console.error(`${queryPrefix} ERROR ${label} (${Date.now() - startedAt}ms)`, error?.message || error);
    }
    throw error;
  }
}

function registerRequestLogger(app) {
  app.use("/api", (req, res, next) => {
    if (!QUERY_LOGGING_ENABLED) {
      next();
      return;
    }

    const startedAt = Date.now();
    const payload = {
      method: req.method,
      path: req.originalUrl,
      query: req.query,
      body: redactSensitiveBody(req.body),
    };

    const logPrefix = getRequestLogPrefix(req);
    console.log(`${logPrefix} ${req.method} ${req.originalUrl}`, payload);

    res.on("finish", () => {
      console.log(
        `${logPrefix} DONE ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - startedAt}ms)`
      );
    });

    next();
  });
}

function registerNoCacheHeaders(app) {
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
  });
}

function loadLocalEnv() {
  if (envLoaded) return;
  envLoaded = true;

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function getEnv(name) {
  loadLocalEnv();
  return process.env[name] || process.env[`VITE_${name}`];
}

function normalizeOpenAIExtractedText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOpenAIMoney(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const cleaned = raw.replace(/[^\d,.-]/g, "");
  if (!cleaned) return "";

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;

  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (lastComma >= 0) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }

  const parsed = Number(normalized);
  return Number.isNaN(parsed) ? "" : String(parsed);
}

function normalizeOpenAIDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split("/");
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";

  return parsed.toISOString().slice(0, 10);
}

function normalizeOpenAIMoneda(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw.includes("USD") || raw.includes("$") || raw.includes("DOLAR") || raw.includes("DÓLAR")) {
    return "USD";
  }
  if (raw.includes("PEN") || raw.includes("SOL") || raw.includes("S/")) {
    return "PEN";
  }
  return "";
}

async function extractVoucherDataWithOpenAI(dataUrl) {
  const apiKey = getEnv("OPENAI_API_KEY");
  const model = getEnv("OPENAI_VOUCHER_MODEL") || "gpt-4o-mini";

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY no está configurada en el backend");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_completion_tokens: 400,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "voucher_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              cliente: { type: "string" },
              numero_operacion: { type: "string" },
              numero_operacion_banco: { type: "string" },
              monto: { type: "string" },
              moneda: { type: "string" },
              fecha_deposito: { type: "string" },
            },
            required: [
              "cliente",
              "numero_operacion",
              "numero_operacion_banco",
              "monto",
              "moneda",
              "fecha_deposito",
            ],
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Eres un extractor de datos de vouchers bancarios. Devuelve solo JSON válido con los campos solicitados. Si un dato no aparece con claridad, devuelve una cadena vacía. No inventes información.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extrae del voucher los campos cliente, numero_operacion, numero_operacion_banco, monto, moneda y fecha_deposito. Usa fecha_deposito en formato YYYY-MM-DD.",
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl,
                detail: "high",
              },
            },
          ],
        },
      ],
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI error ${response.status}: ${rawText}`);
  }

  const payload = JSON.parse(rawText);
  const content = payload?.choices?.[0]?.message?.content || "";
  if (!content) {
    throw new Error("OpenAI no devolvió contenido para la extracción");
  }

  const extracted = JSON.parse(content);
  const cliente = normalizeOpenAIExtractedText(extracted.cliente);
  const numeroOperacion = normalizeOpenAIExtractedText(extracted.numero_operacion).replace(/\D/g, "");
  const numeroOperacionBanco = normalizeOpenAIExtractedText(extracted.numero_operacion_banco).replace(/\D/g, "") || numeroOperacion;
  const monto = normalizeOpenAIMoney(extracted.monto);
  const moneda = normalizeOpenAIMoneda(extracted.moneda);
  const fechaDeposito = normalizeOpenAIDate(extracted.fecha_deposito);

  return {
    cliente,
    numero_operacion: numeroOperacion,
    numero_operacion_banco: numeroOperacionBanco,
    monto,
    moneda,
    fecha_deposito: fechaDeposito,
  };
}

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY") || getEnv("SUPABASE_ANON_KEY");

  if (!url || !key) return null;

  supabaseClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return supabaseClient;
}

function getSupabaseAuthClient() {
  const url = getEnv("SUPABASE_URL");
  const anonKey = getEnv("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;

  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function getSupabaseAdminClient() {
  return getSupabaseClient();
}

function normalizeDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function getLimaDateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

function buildLimaDayRange(dateOnly) {
  const normalized = normalizeDateOnly(dateOnly);
  if (!normalized) {
    return null;
  }

  const start = new Date(`${normalized}T00:00:00-05:00`);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);

  return {
    sinceIso: start.toISOString(),
    untilIso: end.toISOString(),
  };
}

function formatAutomaticSupportReason(pendingCount, depositId) {
  const safeCount = Number.isFinite(Number(pendingCount)) ? Number(pendingCount) : 0;
  const now = new Date();
  const timeFormatter = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = timeFormatter.formatToParts(now);
  const hourPart = parts.find((part) => part.type === "hour")?.value || "00";
  const minutePart = parts.find((part) => part.type === "minute")?.value || "00";
  const timeLabel = `${hourPart}:${minutePart}`;
  const depositLabel = depositId ? `deposito ${String(depositId).trim()}` : "deposito nuevo";
  return `Alerta automatica por ${depositLabel}: hay ${safeCount} depositos pendientes - ${timeLabel}`;
}

function getDepositCreatedAtIso(deposit) {
  const rawValue = deposit?.created_at || deposit?.fecha_registro || null;
  if (!rawValue) {
    return null;
  }

  const createdAt = new Date(rawValue);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  return createdAt.toISOString();
}

function advanceAutomaticSupportAlertCursor(candidateIso) {
  const next = getDepositCreatedAtIso({ created_at: candidateIso });
  if (!next) {
    return;
  }

  const current = new Date(automaticSupportAlertLastReviewedAtIso);
  if (Number.isNaN(current.getTime()) || new Date(next) > current) {
    automaticSupportAlertLastReviewedAtIso = next;
  }
}

function logAutomaticSupportAlertDecision(details) {
  const payload = {
    depositId: details?.depositId || null,
    status: details?.status || null,
    totalPending: Number.isFinite(Number(details?.totalPending))
      ? Number(details.totalPending)
      : 0,
    action: details?.action || "discarded",
    trigger: details?.trigger || "realtime-worker",
    reason: details?.reason || null,
  };

  console.log("[support-requests] automatic alert decision", payload);
}

async function getCurrentPendingDepositCount(client) {
  const pendingCountResult = await runLoggedQuery(
    "depositos.automatic_alert.pending_count",
    {},
    () =>
      client
        .from("depositos")
        .select("id", { count: "exact", head: true })
        .eq("estado", "pendiente")
  );

  if (pendingCountResult?.error) {
    throw pendingCountResult.error;
  }

  return Number(pendingCountResult?.count || 0);
}

async function hasAutomaticSupportAlertForDeposit(client, depositId) {
  const depositLabel = String(depositId || "").trim();
  const existingAlertResult = await runLoggedQuery(
    "support_requests.automatic_alert.find_existing",
    { depositId },
    () =>
      client
        .from("support_requests")
        .select("id, status, source, reason")
        .eq("source", AUTOMATIC_SUPPORT_ALERT_SOURCE)
        .ilike("reason", `%deposito ${depositLabel}%`)
        .maybeSingle()
  );

  if (existingAlertResult?.error) {
    throw existingAlertResult.error;
  }

  return existingAlertResult?.data || null;
}

async function processAutomaticSupportAlertCandidate(client, deposit, options = {}) {
  const depositId = String(deposit?.id || "").trim();
  const status = String(deposit?.estado || deposit?.status || "").trim().toLowerCase();
  const trigger = String(options.trigger || "realtime-worker").trim() || "realtime-worker";
  const totalPending = await getCurrentPendingDepositCount(client);

  if (!depositId) {
    logAutomaticSupportAlertDecision({
      action: "discarded",
      depositId: null,
      status,
      totalPending,
      trigger,
      reason: "deposito sin id",
    });
    return { skipped: true, reason: "deposito sin id" };
  }

  if (status !== "pendiente") {
    logAutomaticSupportAlertDecision({
      action: "discarded",
      depositId,
      status,
      totalPending,
      trigger,
      reason: "estado distinto de pendiente",
    });
    return { skipped: true, reason: "estado distinto de pendiente" };
  }

  if (!Number.isFinite(totalPending) || totalPending < AUTOMATIC_SUPPORT_ALERT_THRESHOLD) {
    logAutomaticSupportAlertDecision({
      action: "discarded",
      depositId,
      status,
      totalPending: Number.isFinite(totalPending) ? totalPending : 0,
      trigger,
      reason: "menos de 4 depositos pendientes",
    });
    return { skipped: true, totalPending, reason: "menos de 4 depositos pendientes" };
  }

  const existingAlert = await hasAutomaticSupportAlertForDeposit(client, depositId);
  if (existingAlert) {
    logAutomaticSupportAlertDecision({
      action: "discarded",
      depositId,
      status,
      totalPending,
      trigger,
      reason: "este deposito ya genero una alerta automatica",
    });
    return { skipped: true, totalPending, reason: "alerta automatica duplicada" };
  }

  const nowIso = new Date().toISOString();
  const reason = formatAutomaticSupportReason(totalPending, depositId);
  const payload = {
    requested_by_id: AUTOMATIC_SUPPORT_ALERT_BOT_ID,
    requested_by_name: AUTOMATIC_SUPPORT_ALERT_BOT_NAME,
    requested_by_role: AUTOMATIC_SUPPORT_ALERT_BOT_ROLE,
    reason,
    pending_count: totalPending,
    status: "pendiente",
    source: AUTOMATIC_SUPPORT_ALERT_SOURCE,
    created_at: nowIso,
    updated_at: nowIso,
  };

  const insertResult = await runLoggedQuery(
    "support_requests.automatic_alert.create",
    { depositId, totalPending, trigger },
    () => client.from("support_requests").insert(payload).select("*").single()
  );

  if (insertResult?.error) {
    if (String(insertResult.error?.code || "") === "23505") {
      logAutomaticSupportAlertDecision({
        action: "discarded",
        depositId,
        status,
        totalPending,
        trigger,
        reason: "alerta automatica ya registrada por una condicion de carrera",
      });
      return { skipped: true, totalPending, reason: "duplicada en concurrencia" };
    }

    throw insertResult.error;
  }

  logAutomaticSupportAlertDecision({
    action: "generated",
    depositId,
    status,
    totalPending,
    trigger,
    reason: "umbral de pendientes alcanzado",
  });

  return {
    skipped: false,
    created: true,
    totalPending,
    data: insertResult?.data || null,
  };
}

function isSupportRequestPendingToday(record, todayLima = getLimaDateOnly()) {
  if (!record) {
    return false;
  }

  const status = String(record.status || "").trim().toLowerCase();
  if (status !== "pendiente") {
    return false;
  }

  const dayRange = buildLimaDayRange(todayLima);
  if (!dayRange || !record.created_at) {
    return false;
  }

  const createdAt = new Date(record.created_at);
  if (Number.isNaN(createdAt.getTime())) {
    return false;
  }

  return createdAt >= new Date(dayRange.sinceIso) && createdAt < new Date(dayRange.untilIso);
}

function shouldBroadcastSupportRequestEvent(eventType, nextRow, previousRow = null) {
  const normalizedEvent = String(eventType || "").trim().toUpperCase();

  if (normalizedEvent === "INSERT") {
    return isSupportRequestPendingToday(nextRow);
  }

  if (normalizedEvent === "UPDATE") {
    return isSupportRequestPendingToday(nextRow) || isSupportRequestPendingToday(previousRow);
  }

  if (normalizedEvent === "DELETE") {
    return isSupportRequestPendingToday(previousRow);
  }

  return false;
}

async function syncAutomaticSupportAlert() {
  if (automaticSupportAlertRunning) {
    return null;
  }

  const client = getSupabaseAdminClient();
  if (!client) {
    return null;
  }

  automaticSupportAlertRunning = true;
  try {
    const sinceIso = automaticSupportAlertLastReviewedAtIso;
    const nowIso = new Date().toISOString();
    const recentDepositsResult = await runLoggedQuery(
      "depositos.automatic_alert.recent_inserts",
      { sinceIso, untilIso: nowIso },
      () =>
        client
          .from("depositos")
          .select("id, estado, fecha_registro")
          .gte("fecha_registro", sinceIso)
          .lte("fecha_registro", nowIso)
          .order("fecha_registro", { ascending: true })
          .order("id", { ascending: true })
    );

    if (recentDepositsResult?.error) {
      throw recentDepositsResult.error;
    }

    const recentDeposits = Array.isArray(recentDepositsResult?.data)
      ? recentDepositsResult.data
      : [];
    let processedCount = 0;
    let generatedCount = 0;

    for (const deposit of recentDeposits) {
      processedCount += 1;
      const result = await processAutomaticSupportAlertCandidate(client, deposit, {
        trigger: "review",
      });
      if (!result?.skipped) {
        generatedCount += 1;
      }
    }

    automaticSupportAlertLastReviewedAtIso = nowIso;

    return {
      sinceIso,
      untilIso: nowIso,
      reviewed: processedCount,
      created: generatedCount,
      skipped: processedCount - generatedCount,
      data: recentDeposits,
    };
  } finally {
    automaticSupportAlertRunning = false;
  }
}

function queueAutomaticSupportAlertCheck() {
  if (automaticSupportAlertDebounceTimeout) {
    return;
  }

  automaticSupportAlertDebounceTimeout = setTimeout(() => {
    automaticSupportAlertDebounceTimeout = null;
    void syncAutomaticSupportAlert().catch((error) => {
      console.warn("[support-requests] automatic alert sync failed:", error?.message || error);
    });
  }, AUTOMATIC_SUPPORT_ALERT_DEBOUNCE_MS);
}

function startAutomaticSupportAlertMonitor() {
  if (!automaticSupportAlertReviewInterval) {
    automaticSupportAlertReviewInterval = setInterval(() => {
      void syncAutomaticSupportAlert().catch((error) => {
        console.warn("[support-requests] automatic alert sync failed:", error?.message || error);
      });
    }, AUTOMATIC_SUPPORT_ALERT_REVIEW_INTERVAL_MS);
  }

  queueAutomaticSupportAlertCheck();
}

function resolveSqlServerEmpresaSuffix(empresa) {
  const suffix = String(empresa || "").trim();
  if (!suffix || !/^\d+$/.test(suffix)) {
    const error = new Error("El parámetro empresa debe ser un sufijo numérico válido");
    error.statusCode = 400;
    throw error;
  }
  return suffix;
}

function resolveSqlServerEmpresaNombre(empresa, overrideName = "") {
  const override = String(overrideName || "").trim();
  if (override) return override;
  return String(empresa || "").trim() === "1"
    ? "JCH COMERCIAL SA"
    : "EVOLUTION CAR SERVICE EIRL";
}

function resolvePeriodMonthRange(period) {
  const normalized = String(period || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    return null;
  }

  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate = new Date(Date.UTC(year, month, 0));

  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
}

function buildSqlServerConfig() {
  const connectionString =
    getEnv("SQLSERVER_CONNECTION_STRING") ||
    getEnv("MSSQL_CONNECTION_STRING") ||
    getEnv("SQL_CONNECTION_STRING");

  if (connectionString) {
    return {
      connectionString,
      pool: {
        max: Number(getEnv("SQLSERVER_POOL_MAX") || 5),
        min: Number(getEnv("SQLSERVER_POOL_MIN") || 0),
        idleTimeoutMillis: Number(getEnv("SQLSERVER_POOL_IDLE_MS") || 30000),
      },
      options: {
        encrypt: String(getEnv("SQLSERVER_ENCRYPT") || "false").toLowerCase() === "true",
        trustServerCertificate:
          String(getEnv("SQLSERVER_TRUST_SERVER_CERTIFICATE") || "true").toLowerCase() !== "false",
        enableArithAbort: true,
      },
    };
  }

  const server = getEnv("SQLSERVER_SERVER") || getEnv("SQL_SERVER") || getEnv("MSSQL_SERVER");
  const database = getEnv("SQLSERVER_DATABASE") || getEnv("SQL_DATABASE") || getEnv("MSSQL_DATABASE");
  const user = getEnv("SQLSERVER_USER") || getEnv("SQL_USER") || getEnv("MSSQL_USER");
  const password = getEnv("SQLSERVER_PASSWORD") || getEnv("SQL_PASSWORD") || getEnv("MSSQL_PASSWORD");

  if (!server || !database || !user || !password) {
    return null;
  }

  return {
    server,
    database,
    user,
    password,
    port: Number(getEnv("SQLSERVER_PORT") || getEnv("SQL_PORT") || 1433),
    pool: {
      max: Number(getEnv("SQLSERVER_POOL_MAX") || 5),
      min: Number(getEnv("SQLSERVER_POOL_MIN") || 0),
      idleTimeoutMillis: Number(getEnv("SQLSERVER_POOL_IDLE_MS") || 30000),
    },
    options: {
      encrypt: String(getEnv("SQLSERVER_ENCRYPT") || "false").toLowerCase() === "true",
      trustServerCertificate:
        String(getEnv("SQLSERVER_TRUST_SERVER_CERTIFICATE") || "true").toLowerCase() !== "false",
      enableArithAbort: true,
    },
  };
}

function getSqlServerConfigSignature(config) {
  if (!config) return null;
  const clone = { ...config };
  if (clone.password) {
    clone.password = "[redacted]";
  }
  if (clone.connectionString) {
    clone.connectionString = "[redacted]";
  }
  return JSON.stringify(clone);
}

async function getSqlServerPool() {
  const config = buildSqlServerConfig();
  if (!config) return null;

  const signature = getSqlServerConfigSignature(config);
  if (sqlServerPool && sqlServerPoolSignature === signature) {
    return sqlServerPool;
  }

  if (sqlServerPool) {
    try {
      await sqlServerPool.close();
    } catch (_error) {
      // Ignorar al reconfigurar.
    }
    sqlServerPool = null;
  }

  sqlServerPoolSignature = signature;
  sqlServerPool = await new sql.ConnectionPool(config).connect();
  return sqlServerPool;
}

async function runLoggedSqlServerQuery(label, details, executor) {
  const startedAt = Date.now();
  if (QUERY_LOGGING_ENABLED) {
    console.log(`[MSSQL] START ${label}`, details || {});
  }

  try {
    const data = await executor();
    if (QUERY_LOGGING_ENABLED) {
      console.log(`[MSSQL] OK ${label} (${Date.now() - startedAt}ms)`, queryPreview(data));
    }
    return { data, error: null };
  } catch (error) {
    if (QUERY_LOGGING_ENABLED) {
      console.error(`[MSSQL] ERROR ${label} (${Date.now() - startedAt}ms)`, {
        message: error.message,
        stack: error.stack,
        details: queryPreview(details),
      });
    }
    return { data: null, error };
  }
}

async function getAuthenticatedUserFromRequest(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    const error = new Error("Authorization token requerido");
    error.statusCode = 401;
    throw error;
  }

  const authClient = getSupabaseAuthClient();
  if (!authClient) {
    const error = new Error("Supabase no estÃ¡ configurado en el backend");
    error.statusCode = 503;
    throw error;
  }

  const { data, error } = await authClient.auth.getUser(token);
  if (error) {
    const authError = new Error(error.message || "No se pudo validar la sesiÃ³n");
    authError.statusCode = 401;
    throw authError;
  }

  const authUser = data?.user || null;
  if (!authUser) {
    const authError = new Error("SesiÃ³n invÃ¡lida");
    authError.statusCode = 401;
    throw authError;
  }

  const { data: profile, error: profileError } = await runLoggedQuery(
    "auth.user.profile",
    { userId: authUser.id },
    () => getSupabaseAdminClient().from("profiles").select("id, rol, estado, nombre, usuario, email").eq("id", authUser.id).maybeSingle()
  );

  if (profileError) {
    const authError = new Error(profileError.message || "No se pudo validar el perfil");
    authError.statusCode = 500;
    throw authError;
  }

  return {
    authUser,
    profile: profile || null,
    isAdmin: String(profile?.rol || "").toLowerCase() === "admin",
  };
}

async function fetchBootstrapData() {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase no estÃ¡ configurado en el backend");
  }

  const [bancosRes, empresasRes, cuentasRes, sucursalesRes, personalRes] =
    await Promise.all([
      runLoggedQuery("bootstrap.bancos", { table: "bancos" }, () =>
        client.from("bancos").select("*").order("nombre", { ascending: true })
      ),
      runLoggedQuery("bootstrap.empresas", { table: "empresas" }, () =>
        client.from("empresas").select("*").order("nombre", { ascending: true })
      ),
      runLoggedQuery("bootstrap.cuentas", { table: "cuentas_bancarias" }, () =>
        client
          .from("cuentas_bancarias")
          .select("*, empresa:empresas(*), banco:bancos(*)")
          .order("created_at", { ascending: false })
      ),
      runLoggedQuery("bootstrap.sucursales", { table: "sucursales" }, () =>
        client.from("sucursales").select("*").order("nombre", { ascending: true })
      ),
      runLoggedQuery("bootstrap.personal", { table: "sucursal_personal" }, () =>
        client.from("sucursal_personal").select("*")
      ),
    ]);

  const errors = [
    bancosRes.error && `Bancos: ${bancosRes.error.message}`,
    empresasRes.error && `Empresas: ${empresasRes.error.message}`,
    cuentasRes.error && `Cuentas: ${cuentasRes.error.message}`,
    sucursalesRes.error && `Sucursales: ${sucursalesRes.error.message}`,
    personalRes.error && `Personal: ${personalRes.error.message}`,
  ].filter(Boolean);

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }

  return {
    bancos: bancosRes.data || [],
    empresas: empresasRes.data || [],
    cuentas: cuentasRes.data || [],
    sucursales: sucursalesRes.data || [],
    personal: personalRes.data || [],
  };
}

async function fetchActiveYCloudConfigs() {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase no estÃ¡ configurado en el backend");
  }

  const { data, error } = await runLoggedQuery(
    "ycloud.configs.list",
    {},
    () =>
      client
        .from("ycloud_config")
        .select("*")
        .order("activo", { ascending: false })
        .order("creado_en", { ascending: false })
  );

  if (error) throw new Error(error.message);
  return data || [];
}

async function fetchActiveYCloudConfig() {
  const configs = await fetchActiveYCloudConfigs();
  return configs.find((config) => config?.activo) || configs[0] || null;
}

const WHATSAPP_MEDIA_BUCKET = "whatsapp-media";

function normalizeConversationPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeStoredPhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function buildConversationPhoneVariants(value) {
  const normalized = normalizeConversationPhone(value);
  if (!normalized) return [];

  const variants = new Set([normalized]);

  if (normalized.startsWith("51") && normalized.length > 9) {
    variants.add(normalized.slice(2));
  }

  if (normalized.length === 9) {
    variants.add(`51${normalized}`);
  }

  return [...variants];
}

function phoneMatchesAnyVariant(value, variants = []) {
  const normalizedValue = normalizeConversationPhone(value);
  if (!normalizedValue) return false;

  return variants.some((variant) => {
    const normalizedVariant = normalizeConversationPhone(variant);
    if (!normalizedVariant) return false;
    return (
      normalizedValue === normalizedVariant ||
      normalizedValue.includes(normalizedVariant) ||
      normalizedVariant.includes(normalizedValue)
    );
  });
}

async function resolveConversationPhoneFromDepositId(depositId) {
  const client = getSupabaseAdminClient();
  if (!client || !depositId) return "";

  const { data, error } = await runLoggedQuery(
    "whatsapp.conversation.depositPhone",
    { depositId },
    () =>
      client
        .from("depositos")
        .select(
          `
          id,
          telefono_origen,
          trabajador:trabajador_sucursal_id ( telefono_origen ),
          sucursal:sucursal_id ( telefono )
        `
        )
        .eq("id", depositId)
        .maybeSingle()
  );

  if (error || !data) return "";

  const candidates = [
    data?.telefono_origen,
    data?.trabajador?.telefono_origen,
    data?.sucursal?.telefono,
  ];

  return candidates.map(normalizeConversationPhone).find(Boolean) || "";
}

function safeFileName(value, fallback = "media") {
  const raw = String(value || fallback).trim() || fallback;
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMimeType(mimeType = "", fallback = "") {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("pdf")) return "pdf";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("audio")) return "ogg";
  const match = String(fallback || "").toLowerCase().match(/\.([a-z0-9]{2,5})(?:$|\?)/);
  return match?.[1] || "bin";
}

function extractConversationMessages(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.messages)) return payload.messages;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.entry)) {
    return payload.entry.flatMap((entry) => entry?.changes || []).flatMap((change) => change?.value?.messages || []);
  }
  if (payload.message) return [payload.message];
  return [payload];
}

function extractWebhookMessageId(message, payload) {
  const rawPayload = message?.rawPayload || payload?.rawPayload || payload || {};
  return (
    message?.whatsappInboundMessage?.id ||
    message?.whatsappInboundMessageId ||
    rawPayload?.whatsappInboundMessage?.id ||
    rawPayload?.whatsappInboundMessageId ||
    message?.id ||
    message?.message_id ||
    message?.externalId ||
    payload?.messageId ||
    null
  );
}

function extractWebhookPhoneNumber(message, payload) {
  const candidates = [
    message?.from,
    message?.sender,
    message?.wa_id,
    message?.contact?.wa_id,
    message?.contacts?.[0]?.wa_id,
    payload?.from,
    payload?.sender,
    payload?.wa_id,
  ];

  return candidates.map(normalizeConversationPhone).find(Boolean) || "";
}

function extractWebhookAttachment(message) {
  return {
    attachmentType: message?.type || "",
    attachmentUrl:
      message?.image?.link ||
      message?.image?.url ||
      message?.document?.link ||
      message?.document?.url ||
      message?.video?.link ||
      message?.video?.url ||
      message?.audio?.link ||
      message?.audio?.url ||
      message?.media?.link ||
      message?.media?.url ||
      "",
    attachmentName:
      message?.image?.caption ||
      message?.document?.filename ||
      message?.document?.name ||
      message?.video?.caption ||
      message?.audio?.caption ||
      "",
  };
}

async function uploadWhatsAppMediaToStorage(
  client,
  mediaUrl,
  { phoneNumber = "", messageId = "", attachmentType = "", attachmentName = "", mimeType = "" } = {},
) {
  if (!client || !mediaUrl) return null;

  const response = await fetch(mediaUrl);
  if (!response.ok) {
    throw new Error(`No se pudo descargar el adjunto (${response.status})`);
  }

  const contentType = mimeType || response.headers.get("content-type") || "";
  const extension = guessExtensionFromMimeType(contentType, mediaUrl);
  const fileBaseName = safeFileName(attachmentName || `${messageId || "media"}.${extension}`);
  const phoneFolder = normalizeConversationPhone(phoneNumber) || "sin-telefono";
  const storagePath = `conversations/${phoneFolder}/${Date.now()}-${fileBaseName}`;
  const buffer = Buffer.from(await response.arrayBuffer());

  const { error: uploadError } = await client.storage.from(WHATSAPP_MEDIA_BUCKET).upload(storagePath, buffer, {
    contentType: contentType || "application/octet-stream",
    upsert: true,
  });

  if (uploadError) {
    throw uploadError;
  }

  const { data: publicUrlData } = client.storage.from(WHATSAPP_MEDIA_BUCKET).getPublicUrl(storagePath);

  return {
    bucket: WHATSAPP_MEDIA_BUCKET,
    path: storagePath,
    publicUrl: publicUrlData?.publicUrl || null,
    contentType: contentType || null,
    attachmentType: attachmentType || null,
    attachmentName: attachmentName || fileBaseName,
  };
}

function normalizeStoredConversationMessage(row) {
  const contenido = row?.contenido && typeof row.contenido === "object" ? row.contenido : {};
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const messageContext =
    metadata?.context && typeof metadata.context === "object"
      ? metadata.context
      : contenido?.context && typeof contenido.context === "object"
        ? contenido.context
        : null;
  const attachmentUrl =
    row?.attachment_url ||
    metadata?.attachment_url ||
    metadata?.media_url ||
    metadata?.media_public_url ||
    contenido?.image?.link ||
    contenido?.document?.link ||
    contenido?.video?.link ||
    contenido?.audio?.link ||
    "";

  const attachmentName =
    row?.attachment_name ||
    metadata?.attachment_name ||
    contenido?.document?.filename ||
    contenido?.image?.caption ||
    contenido?.document?.caption ||
    contenido?.video?.caption ||
    contenido?.audio?.caption ||
    "";

  const attachmentType = row?.attachment_mime_type || metadata?.attachment_type || row?.tipo_mensaje || contenido?.type || "";
  const direction = row?.direction || metadata?.direction || "outbound";
  const caption =
    contenido?.image?.caption ||
    contenido?.document?.caption ||
    contenido?.video?.caption ||
    contenido?.audio?.caption ||
    metadata?.caption ||
    "";
  const replyToMessageId =
    row?.reply_to_message_id ||
    row?.replyToMessageId ||
    metadata?.reply_to_message_id ||
    metadata?.replyToMessageId ||
    messageContext?.message_id ||
    messageContext?.id ||
    contenido?.replyToMessageId ||
    contenido?.reply_to_message_id ||
    contenido?.quoted_message_id ||
    null;
  const replyToText =
    metadata?.reply_to_text ||
    messageContext?.text ||
    messageContext?.body ||
    messageContext?.caption ||
    contenido?.replyToText ||
    contenido?.reply_to_text ||
    "";
  const rawText =
    contenido?.text?.body ||
    contenido?.body ||
    contenido?.message ||
    row?.mensaje ||
    row?.contenido ||
    "";

  return {
    id: row?.message_id || row?.id || null,
    direction,
    text: String(rawText || ""),
    content: String(rawText || ""),
    caption,
    type: row?.tipo_mensaje || contenido?.type || "text",
    status: row?.estado || metadata?.status || "",
    timestamp: row?.enviado_en || metadata?.timestamp || row?.received_at || row?.created_at || null,
    createdAt: row?.enviado_en || row?.created_at || null,
    to: row?.telefono_destino || metadata?.to || "",
    from: metadata?.from || metadata?.sender || metadata?.phone || "",
    attachmentUrl,
    attachmentName,
    attachmentType,
    source: row?.source || metadata?.source || "database",
    mediaStoragePath: row?.storage_path || metadata?.storage_path || null,
    replyToMessageId: replyToMessageId ? String(replyToMessageId) : null,
    replyToText: String(replyToText || "").trim(),
  };
}

function normalizeYCloudMessage(msg, normalizedPhone, configFromNumber, phoneVariants = []) {
  const msgFrom = normalizeConversationPhone(msg?.from || "");
  const msgTo = normalizeConversationPhone(msg?.to || "");
  const normalizedConversationVariants = phoneVariants.length > 0 ? phoneVariants : buildConversationPhoneVariants(normalizedPhone);
  const isOutbound = configFromNumber
    ? phoneMatchesAnyVariant(msgFrom, [configFromNumber])
    : phoneMatchesAnyVariant(msgFrom, normalizedConversationVariants) &&
      !phoneMatchesAnyVariant(msgTo, normalizedConversationVariants);

  const attachmentUrl =
    msg?.image?.link ||
    msg?.image?.url ||
    msg?.document?.link ||
    msg?.document?.url ||
    msg?.video?.link ||
    msg?.video?.url ||
    msg?.audio?.link ||
    msg?.audio?.url ||
    "";

  const attachmentName =
    msg?.document?.filename ||
    msg?.image?.caption ||
    msg?.document?.caption ||
    msg?.video?.caption ||
    msg?.audio?.caption ||
    "";
  const caption =
    msg?.text?.body ||
    msg?.image?.caption ||
    msg?.document?.caption ||
    msg?.video?.caption ||
    msg?.audio?.caption ||
    "";

  return {
    id: msg?.id || msg?.externalId || `${msg?.createTime || msg?.sendTime || Date.now()}-${Math.random().toString(36).slice(2)}`,
    direction: isOutbound ? "outbound" : "inbound",
    text: msg?.text?.body || msg?.template?.name || "",
    content: msg?.text?.body || msg?.template?.name || (msg?.type !== "text" ? `[${msg?.type}]` : ""),
    caption,
    type: msg?.type || "text",
    status: msg?.status || "",
    timestamp: msg?.createTime || msg?.sendTime || null,
    createdAt: msg?.createTime || null,
    to: msg?.to || "",
    from: msg?.from || "",
    attachmentUrl,
    attachmentName,
    attachmentType: msg?.type || "",
    source: "ycloud",
    externalId: msg?.externalId || null,
    errorCode: msg?.errorCode || null,
    errorMessage: msg?.errorMessage || null,
  };
}

function buildDocumentsVoucherSearchTerms(search) {
  const normalized = String(search || "").trim().toLowerCase();
  if (!normalized) return [];

  const variants = new Set([normalized]);
  const compact = normalized.replace(/\s+/g, "");
  if (compact) variants.add(compact);

  return [...variants];
}

function matchesDocumentVoucherSearch(deposit, searchTerms) {
  if (!searchTerms.length) return true;

  const montoText = deposit.monto != null ? String(deposit.monto) : "";
  const fechaText = deposit.fecha_deposito
    ? new Date(String(deposit.fecha_deposito).replace(/-/g, "/")).toLocaleDateString("es-ES")
    : "";
  const haystack = [
    deposit.numero_operacion,
    deposit.cliente,
    deposit.referencia_cliente,
    deposit.ruc_cliente,
    deposit.moneda,
    deposit.observaciones,
    deposit.sucursal?.nombre,
    deposit.banco?.abreviatura,
    deposit.empresa?.nombre,
    montoText,
    fechaText,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(" ");

  return searchTerms.some((term) => haystack.includes(term));
}

async function fetchDocumentsVoucherPage({ date, period, search, page = 1, pageSize = 12 }) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 12));
  const searchTerms = buildDocumentsVoucherSearchTerms(search);

  if (searchTerms.length > 0) {
    const deposits = await fetchDeposits({
      date,
      period,
      limit: 5000,
    });

    const vouchers = (deposits || []).filter((deposit) => deposit.imagen_voucher);
    const filtered = vouchers.filter((deposit) => matchesDocumentVoucherSearch(deposit, searchTerms));
    const total = filtered.length;
    const start = (safePage - 1) * safePageSize;
    const data = filtered.slice(start, start + safePageSize);

    return {
      data,
      total,
      page: safePage,
      pageSize: safePageSize,
      hasMore: start + safePageSize < total,
    };
  }

  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase no estÃƒÂ¡ configurado en el backend");
  }

  const selectFields = `id, numero_operacion, cliente, monto, fecha_registro, fecha_solo_date, imagen_voucher, anexo, numero_operacion_banco, fecha_deposito, estado, observaciones, motivo_rechazo, fecha_validacion, referencia_cliente, validado_por, moneda, ruc_cliente, telefono_origen, chatwoot_message_id, es_antiguo,
    empresa:empresa_id (id, nombre, estado, abreviatura),
    banco:banco_id (id, abreviatura, estado),
    sucursal:sucursal_id (id, nombre),
    trabajador:trabajador_sucursal_id (id, nombre, telefono_origen),
    validado_por_usuario:validado_por (id, nombre)`;

  let query = client
    .from("depositos")
    .select(selectFields, { count: "exact" })
    .not("imagen_voucher", "is", null)
    .neq("imagen_voucher", "");

  if (date) {
    query = query.eq("fecha_solo_date", date);
  } else if (period) {
    const now = new Date();
    if (period.startsWith("month:")) {
      const [year, month] = period.split(":")[1].split("-").map(Number);
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 0);
      query = query
        .gte("fecha_solo_date", startOfMonth.toISOString().split("T")[0])
        .lte("fecha_solo_date", endOfMonth.toISOString().split("T")[0]);
    } else {
      switch (period) {
        case "today":
          query = query.eq("fecha_solo_date", now.toISOString().split("T")[0]);
          break;
        case "week": {
          const dayOfWeek = now.getDay();
          const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          const startOfWeek = new Date(now);
          startOfWeek.setDate(now.getDate() - daysFromMonday);
          startOfWeek.setHours(0, 0, 0, 0);
          const endOfWeek = new Date(startOfWeek);
          endOfWeek.setDate(startOfWeek.getDate() + 6);
          endOfWeek.setHours(23, 59, 59, 999);
          query = query
            .gte("fecha_solo_date", startOfWeek.toISOString().split("T")[0])
            .lte("fecha_solo_date", endOfWeek.toISOString().split("T")[0]);
          break;
        }
        case "month": {
          const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
          const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          query = query
            .gte("fecha_solo_date", startOfMonth.toISOString().split("T")[0])
            .lte("fecha_solo_date", endOfMonth.toISOString().split("T")[0]);
          break;
        }
        default:
          break;
      }
    }
  }

  const from = (safePage - 1) * safePageSize;
  const to = from + safePageSize - 1;
  const { data, error, count } = await runLoggedQuery(
    "documents.vouchers.page",
    { date, period, page: safePage, pageSize: safePageSize },
    () => query.order("fecha_registro", { ascending: false }).range(from, to)
  );

  if (error) throw new Error(error.message);

  return {
    data: data || [],
    total: count || 0,
    page: safePage,
    pageSize: safePageSize,
    hasMore: from + safePageSize < (count || 0),
  };
}

async function fetchYCloudConfigById(configId) {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase no estÃ¡ configurado en el backend");
  }

  const { data, error } = await runLoggedQuery(
    "ycloud.config.byId",
    { configId },
    () => client.from("ycloud_config").select("*").eq("id", configId).single()
  );

  if (error) throw new Error(error.message);
  return data;
}

function buildYCloudPayload(messageData, config) {
  const {
    to,
    from,
    type = "text",
    text,
    template,
    image,
    document,
    video,
    audio,
    location,
    interactive,
    context,
    replyToMessageId,
    filterUnsubscribed,
    externalId,
  } = messageData;

  const payload = {
    to,
    from: from || config.default_from_number,
    type,
  };

  switch (type) {
    case "text":
      if (!text || !text.body) throw new Error("text.body es requerido");
      payload.text = {
        body: text.body,
        previewUrl: text.previewUrl || false,
      };
      break;
    case "template":
      if (!template || !template.name) throw new Error("template.name es requerido");
      payload.template = {
        name: template.name,
        language: { code: template.language || "es" },
        components: template.components || [],
      };
      break;
    case "image":
      if (!image) throw new Error("image es requerido");
      payload.image = {
        link: image.link,
        caption: image.caption || undefined,
      };
      break;
    case "document":
      if (!document) throw new Error("document es requerido");
      payload.document = {
        link: document.link,
        filename: document.filename || undefined,
        caption: document.caption || undefined,
      };
      break;
    case "video":
      if (!video) throw new Error("video es requerido");
      payload.video = {
        link: video.link,
        caption: video.caption || undefined,
      };
      break;
    case "audio":
      if (!audio) throw new Error("audio es requerido");
      payload.audio = { link: audio.link };
      break;
    case "location":
      if (!location) throw new Error("location es requerido");
      payload.location = {
        latitude: location.latitude,
        longitude: location.longitude,
        name: location.name || undefined,
        address: location.address || undefined,
      };
      break;
    case "interactive":
      if (!interactive) throw new Error("interactive es requerido");
      payload.interactive = interactive;
      break;
    default:
      throw new Error(`Tipo de mensaje no soportado: ${type}`);
  }

  const replyContext =
    context && typeof context === "object"
      ? context
      : replyToMessageId
        ? { message_id: replyToMessageId }
        : null;

  if (replyContext) payload.context = replyContext;
  if (filterUnsubscribed !== undefined) payload.filterUnsubscribed = filterUnsubscribed;
  if (externalId) payload.externalId = externalId;

  return payload;
}

function extractYCloudWamid(responseData) {
  const candidate =
    responseData?.messages?.[0]?.wamid ||
    responseData?.messages?.[0]?.message_id ||
    responseData?.messages?.[0]?.messageId ||
    responseData?.messages?.[0]?.id ||
    responseData?.wamid ||
    responseData?.message_id ||
    responseData?.messageId ||
    responseData?.id ||
    null;

  return candidate ? String(candidate) : null;
}

async function sendYCloudMessage(messageData) {
  const configId = messageData.configId;
  if (!configId) {
    throw new Error("configId es requerido");
  }

  const config = await fetchYCloudConfigById(configId);
  if (!config || !config.activo) {
    throw new Error("ConfiguraciÃ³n YCloud no encontrada o inactiva");
  }

  const resolvedTo = normalizeYCloudPhoneNumber(messageData.to || "");
  if (!resolvedTo) {
    throw new Error("to es requerido");
  }
  if (!/^\+\d{8,15}$/.test(resolvedTo)) {
    throw new Error(`El número to de YCloud no tiene formato E.164 válido: ${resolvedTo}`);
  }

  const resolvedFrom = normalizeYCloudPhoneNumber(
    messageData.from || config.default_from_number || "",
  );
  if (!resolvedFrom) {
    throw new Error("La configuración YCloud no tiene default_from_number y no se recibió from");
  }
  if (!/^\+\d{8,15}$/.test(resolvedFrom)) {
    throw new Error(`El número from de YCloud no tiene formato E.164 válido: ${resolvedFrom}`);
  }

  const client = getSupabaseAdminClient();
  const payload = buildYCloudPayload(
    {
      ...messageData,
      to: resolvedTo,
      from: resolvedFrom,
      context:
        messageData.context ||
        (messageData.replyToMessageId ? { message_id: messageData.replyToMessageId } : undefined),
    },
    config
  );
  const response = await fetch(YCLOUD_SEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-API-Key": config.api_key,
    },
    body: JSON.stringify(payload),
  });

  const responseData = await response.json();
  if (!response.ok) {
    const ycloudError =
      responseData?.error?.whatsappApiError?.message ||
      responseData?.error?.message ||
      responseData?.error?.details ||
      responseData?.message ||
      response.statusText ||
      "YCloud request failed";

    console.error("[YCLOUD] sendDirectly failed", {
      status: response.status,
      error: responseData?.error || responseData,
      payload: {
        to: payload.to,
        from: payload.from,
        type: payload.type,
        hasContext: !!payload.context,
      },
    });

    throw new Error(`YCloud API Error ${response.status}: ${ycloudError}`);
  }

  return {
    ...responseData,
    __payload: payload,
  };
}

async function fetchWhatsAppCredentials() {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase no estÃ¡ configurado en el backend");
  }

  const tryRpc = await runLoggedQuery("whatsapp.credentials.rpc", {}, () =>
    client.rpc("get_whatsapp_credentials")
  );
  if (!tryRpc.error && Array.isArray(tryRpc.data) && tryRpc.data.length > 0) {
    return tryRpc.data[0];
  }

  const fallback = await runLoggedQuery("whatsapp.credentials.table", {}, () =>
    client
      .from("whatsapp_config")
      .select("phone_number_id, access_token, activo, alias, created_at")
      .eq("activo", true)
      .order("created_at", { ascending: false })
      .limit(1)
  );

  if (fallback.error) {
    throw new Error(fallback.error.message);
  }

  return fallback.data?.[0] || null;
}

async function sendWhatsAppMessage(messageData) {
  const credentials = await fetchWhatsAppCredentials();
  if (!credentials?.phone_number_id || !credentials?.access_token) {
    throw new Error("Credenciales de WhatsApp no configuradas");
  }

  const endpoint = `${process.env.WHATSAPP_GRAPH_BASE_URL || "https://graph.facebook.com/v24.0"}/${credentials.phone_number_id}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    ...messageData,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseData = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `WhatsApp API Error ${response.status}: ${
        responseData.error?.message || response.statusText
      }`
    );
  }

  return responseData;
}

function buildFallbackWhatsappLogRows(row) {
  const baseRow = {
    telefono_destino: normalizeStoredPhone(row?.telefono_destino || null) || null,
    tipo_mensaje: row?.tipo_mensaje || "text",
    contenido: row?.contenido || {},
    message_id: row?.message_id || null,
    wamid: row?.wamid || null,
    estado: row?.estado || "enviado",
    error_mensaje: row?.error_mensaje || null,
    metadata: row?.metadata || {},
    enviado_por: row?.enviado_por || null,
    enviado_en: row?.enviado_en || new Date().toISOString(),
  };

  return [
    {
      ...baseRow,
      configuracion_id: row?.configuracion_id || null,
      direction: row?.direction || "outbound",
      source: row?.source || "ycloud",
      conversation_key: row?.conversation_key || normalizeConversationPhone(row?.telefono_destino || ""),
      attachment_url: row?.attachment_url || null,
      attachment_name: row?.attachment_name || null,
      attachment_mime_type: row?.attachment_mime_type || null,
      storage_bucket: row?.storage_bucket || "whatsapp-media",
      storage_path: row?.storage_path || null,
      wamid: row?.wamid || null,
    },
    {
      ...baseRow,
      configuracion_id: row?.configuracion_id || null,
      direction: row?.direction || "outbound",
      source: row?.source || "ycloud",
      conversation_key: row?.conversation_key || normalizeConversationPhone(row?.telefono_destino || ""),
      wamid: row?.wamid || null,
    },
    baseRow,
  ];
}

async function logWhatsAppMessageViaRpc(client, row) {
  if (!client) return null;

  const rpcPayload = {
    p_telefono_destino: row?.telefono_destino || null,
    p_tipo_mensaje: row?.tipo_mensaje || "text",
    p_contenido: row?.contenido || {},
    p_message_id: row?.message_id || null,
    p_metadata: {
      ...(row?.metadata || {}),
      direction: row?.direction || "outbound",
      source: row?.source || "ycloud",
      state: row?.estado || null,
      conversation_key: row?.conversation_key || normalizeConversationPhone(row?.telefono_destino || ""),
      attachment_url: row?.attachment_url || null,
      attachment_name: row?.attachment_name || null,
      attachment_mime_type: row?.attachment_mime_type || null,
      storage_bucket: row?.storage_bucket || null,
      storage_path: row?.storage_path || null,
      reply_to_message_id: row?.reply_to_message_id || null,
      reply_to_text: row?.reply_to_text || null,
      reply_to_direction: row?.reply_to_direction || null,
    },
  };

  const rpcResult = await runLoggedQuery("whatsapp.messages.log.rpc", rpcPayload, () =>
    client.rpc("log_whatsapp_message", rpcPayload)
  );

  if (rpcResult.error) {
    throw new Error(rpcResult.error.message);
  }

  if (rpcResult.data == null) {
    return null;
  }

  if (typeof rpcResult.data === "object") {
    return rpcResult.data;
  }

  return { id: rpcResult.data };
}

async function logWhatsAppMessage(client, row) {
  const attempts = buildFallbackWhatsappLogRows(row);
  let lastError = null;

  for (const payload of attempts) {
    const result = await runLoggedQuery("whatsapp.messages.log", payload, () =>
      client.from("whatsapp_mensajes_log").insert(payload).select("*").maybeSingle()
    );

    if (!result.error) {
      return result.data || payload;
    }

    lastError = result.error;
    console.warn("No se pudo registrar el log de WhatsApp con el payload actual:", result.error.message);
  }

  try {
    const rpcResult = await logWhatsAppMessageViaRpc(client, row);
    if (rpcResult !== null && rpcResult !== undefined) {
      return rpcResult;
    }
  } catch (rpcError) {
    lastError = rpcError;
    console.warn("No se pudo registrar el log de WhatsApp mediante RPC:", rpcError.message);
  }

  throw new Error(lastError?.message || "No se pudo registrar el log de WhatsApp");
}

async function logYCloudOutboundMessageMinimal(client, row) {
  if (!client) return { logInserted: false, logError: null };

  const payload = {
    telefono_destino: normalizeStoredPhone(row?.telefono_destino || row?.to || null) || null,
    tipo_mensaje: row?.tipo_mensaje || "text",
    contenido: row?.contenido || row || {},
    estado: row?.estado || "enviado",
    enviado_en: row?.enviado_en || new Date().toISOString(),
    message_id: row?.message_id || null,
    wamid: row?.reply_to_message_id  || null,
    direction: row?.direction || "outbound",
    source: row?.source || "ycloud",
    conversation_key: row?.conversation_key || normalizeConversationPhone(row?.telefono_destino || row?.to || ""),
    configuracion_id: row?.configuracion_id || null,
    metadata: row?.metadata || {},
  };

  const result = await runLoggedQuery(
    "whatsapp.messages.log.minimal",
    payload,
    () => client.from("whatsapp_mensajes_log").insert(payload).select("*").maybeSingle()
  );

  if (result.error) {
    return { logInserted: false, logError: result.error.message };
  }

  return { logInserted: true, logError: null };
}

async function logYCloudOutboundMessage(client, reqBody, data, extra = {}) {
  if (!client) return { logInserted: false, logError: null };

  try {
    const { metadata: extraMetadataInput, ...extraRow } = extra || {};
    const extraMetadata = extraMetadataInput && typeof extraMetadataInput === "object" ? extraMetadataInput : {};
    const outboundWamid = extractYCloudWamid(data);
    const logResult = await logWhatsAppMessage(client, {
      telefono_destino: normalizeStoredPhone(reqBody?.to || null),
      tipo_mensaje: reqBody?.type || "text",
      contenido: reqBody || {},
      estado: "enviado",
      enviado_en: new Date().toISOString(),
      message_id: outboundWamid,
      wamid: outboundWamid,
      direction: "outbound",
      source: "ycloud",
      conversation_key: normalizeConversationPhone(reqBody?.to || ""),
      configuracion_id: reqBody?.configId || null,
      metadata: {
        direction: "outbound",
        source: "ycloud",
        to: reqBody?.to || null,
        reply_to_message_id: reqBody?.replyToMessageId || null,
        reply_to_wamid: extraMetadata.reply_to_wamid || null,
        reply_to_text: extraMetadata.reply_to_text || null,
        reply_to_direction: extraMetadata.reply_to_direction || null,
        context: reqBody?.context || null,
        ...extraMetadata,
      },
      ...extraRow,
    });
    const logRowId =
      logResult && typeof logResult === "object"
        ? logResult.id ?? logResult.logId ?? null
        : typeof logResult === "number" || typeof logResult === "string"
          ? logResult
          : null;

    return { logInserted: !!logResult, logError: null, logId: logRowId };
  } catch (error) {
    console.warn("No se pudo persistir el log outbound de YCloud:", error.message);
    return { logInserted: false, logError: error.message, logId: null };
  }
}

async function fetchDeposits({
  date,
  period,
  ids,
  limit = 500,
  regularized = false,
}) {
  const client = getSupabaseAdminClient();
  if (!client) {
    throw new Error("Supabase no estÃ¡ configurado en el backend");
  }

  let query = client.from("depositos").select(
    `id, numero_operacion, cliente, monto, fecha_registro, fecha_solo_date, imagen_voucher, anexo, numero_operacion_banco, fecha_deposito, estado, observaciones, motivo_rechazo, fecha_validacion, referencia_cliente, validado_por, moneda, ruc_cliente, telefono_origen, chatwoot_message_id, es_antiguo,
  empresa:empresa_id (id, nombre, estado, abreviatura),
  banco:banco_id (id, abreviatura, estado),
  sucursal:sucursal_id (id, nombre),
  trabajador:trabajador_sucursal_id (id, nombre, telefono_origen),
  validado_por_usuario:validado_por (id, nombre)`
  );

  if (regularized) {
    query = query
      .ilike("observaciones", "%**registros manual**%")
      .order("fecha_registro", { ascending: false })
      .limit(limit);
    const { data, error } = await runLoggedQuery(
      "depositos.regularized",
      { regularized: true, limit },
      () => query
    );
    if (error) throw new Error(error.message);
    return data || [];
  }

  if (Array.isArray(ids) && ids.length > 0) {
    const uniqueIds = [...new Set(ids.map((value) => String(value).trim()).filter(Boolean))];
    const chunks = chunkArray(uniqueIds, 100);
    const results = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkQuery = client
        .from("depositos")
        .select(
          `id, numero_operacion, cliente, monto, fecha_registro, fecha_solo_date, imagen_voucher, anexo, numero_operacion_banco, fecha_deposito, estado, observaciones, motivo_rechazo, fecha_validacion, referencia_cliente, validado_por, moneda, ruc_cliente, telefono_origen, chatwoot_message_id, es_antiguo,
  empresa:empresa_id (id, nombre, estado, abreviatura),
  banco:banco_id (id, abreviatura, estado),
  sucursal:sucursal_id (id, nombre),
  trabajador:trabajador_sucursal_id (id, nombre, telefono_origen),
  validado_por_usuario:validado_por (id, nombre)`
        )
        .in("id", chunk)
        .order("fecha_registro", { ascending: false });

      const { data, error } = await runLoggedQuery(
        "depositos.byIds.chunk",
        { chunkIndex: index, chunkSize: chunk.length, totalIds: uniqueIds.length },
        () => chunkQuery
      );

      if (error) throw new Error(error.message);
      if (Array.isArray(data) && data.length > 0) {
        results.push(...data);
      }
    }

    results.sort((a, b) => {
      const aTime = new Date(a.fecha_registro || a.fecha_solo_date || 0).getTime();
      const bTime = new Date(b.fecha_registro || b.fecha_solo_date || 0).getTime();
      return bTime - aTime;
    });

    return results.slice(0, limit);
  }

  if (date) {
    query = query.eq("fecha_solo_date", date).order("fecha_registro", { ascending: false });
    const { data, error } = await runLoggedQuery("depositos.byDate", { date }, () => query);
    if (error) throw new Error(error.message);
    return data || [];
  }

  if (period) {
    const now = new Date();
    if (period.startsWith("month:")) {
      const [year, month] = period.split(":")[1].split("-").map(Number);
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 0);
      query = query
        .gte("fecha_solo_date", startOfMonth.toISOString().split("T")[0])
        .lte("fecha_solo_date", endOfMonth.toISOString().split("T")[0]);
    } else {
      switch (period) {
        case "today":
          query = query.eq("fecha_solo_date", now.toISOString().split("T")[0]);
          break;
        case "week": {
          const dayOfWeek = now.getDay();
          const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          const startOfWeek = new Date(now);
          startOfWeek.setDate(now.getDate() - daysFromMonday);
          startOfWeek.setHours(0, 0, 0, 0);
          const endOfWeek = new Date(startOfWeek);
          endOfWeek.setDate(startOfWeek.getDate() + 6);
          endOfWeek.setHours(23, 59, 59, 999);
          query = query
            .gte("fecha_solo_date", startOfWeek.toISOString().split("T")[0])
            .lte("fecha_solo_date", endOfWeek.toISOString().split("T")[0]);
          break;
        }
        case "month": {
          const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
          const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          query = query
            .gte("fecha_solo_date", startOfMonth.toISOString().split("T")[0])
            .lte("fecha_solo_date", endOfMonth.toISOString().split("T")[0]);
          break;
        }
        default:
          break;
      }
    }

    let allData = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error } = await runLoggedQuery(
        "depositos.byPeriod.page",
        { period, page, from, to },
        () =>
          query
            .order("fecha_registro", { ascending: false })
            .range(from, to)
      );

      if (error) throw new Error(error.message);

      allData = [...allData, ...(data || [])];
      hasMore = data && data.length === pageSize;
      page += 1;
      if (page >= 50) hasMore = false;
    }

    return allData;
  }

  const { data, error } = await runLoggedQuery(
    "depositos.all",
    { limit },
    () => query.order("fecha_registro", { ascending: false }).limit(limit)
  );
  if (error) throw new Error(error.message);
  return data || [];
}

async function fetchMovimientosPorIdentificarSqlServer({
  empresa,
  empresaNombre,
  fechaInicio,
  fechaFin,
  searchTerm,
  nroOperacion = "",
  banco = "",
  fecha = "",
  importe = "",
  limit = 250,
  offset = 0,
}) {
  const pool = await getSqlServerPool();
  if (!pool) {
    throw new Error("SQL Server no está configurado en el backend");
  }

  const empresaSuffix = resolveSqlServerEmpresaSuffix(empresa);
  const resolvedEmpresaNombre = resolveSqlServerEmpresaNombre(empresa, empresaNombre);
  const normalizedLimit = Math.min(Math.max(Number(limit) || 250, 1), 2000);
  const normalizedOffset = Math.max(Number(offset) || 0, 0);
  const normalizedSearch = String(searchTerm || "").trim();
  const startDate = normalizeDateOnly(fechaInicio);
  const endDate = normalizeDateOnly(fechaFin);
  const searchPattern = normalizedSearch ? `%${normalizedSearch}%` : null;

  const request = pool.request();
  request.input("empresaNombre", sql.NVarChar(150), resolvedEmpresaNombre);
  request.input("fechaInicio", sql.Date, startDate ? new Date(`${startDate}T00:00:00`) : null);
  request.input("fechaFin", sql.Date, endDate ? new Date(`${endDate}T00:00:00`) : null);
  request.input("searchTerm", sql.NVarChar(sql.MAX), searchPattern);
  request.input("limit", sql.Int, normalizedLimit);
  request.input("offset", sql.Int, normalizedOffset);

  const queryText = `
WITH TCORTADO AS (
  SELECT
    T1.ID,
    T1.CUO,
    T1.CUOA,
    T1.BANCO,
    T1.CTA,
    T1.FECHA,
    T1.DESCRIPCION,
    T1.PLAZA,
    T1.NRO_OPER,
    T1.CARGO,
    T1.ABONO,
    T1.SD,
    T1.COMP,
    T1.TIPO,
    T1.TIENDA AS AGENCIA,
    T1.RUC,
    T1.RAZON_SOCIAL_CLIENTE AS RAZON,
    T1.UBICACION,
    T1.DIRECCION,
    SUM(ISNULL(T2.IMPORTE, 0)) AS REG,
    CASE
      WHEN COUNT(DISTINCT NULLIF(LTRIM(RTRIM(T2.REGISTRO)), '')) > 1 THEN 'VARIOS'
      ELSE ISNULL(MAX(NULLIF(LTRIM(RTRIM(T2.REGISTRO)), '')), '')
    END AS REGISTRO,
  T1.OBSERVACION AS Observacion
  FROM Creditos.dbo.CORTADO${empresaSuffix} T1 WITH (NOLOCK)
  LEFT JOIN Creditos.dbo.RegistrosConcar${empresaSuffix} T2 WITH (NOLOCK)
    ON T2.MCUO = T1.CUO
   AND T2.ESTADO <> 'ELIMINADO'
  WHERE T1.FECHA >= COALESCE(@fechaInicio, DATEFROMPARTS(YEAR(GETDATE()), 1, 1))
    AND T1.FECHA < DATEADD(DAY, 1, COALESCE(@fechaFin, CONVERT(date, GETDATE())))
    AND T1.ABONO > 0
    AND T1.TIPO NOT IN ('LT', 'TJ', 'ITF')
  GROUP BY
    T1.ID, T1.CUO, T1.CUOA, T1.BANCO, T1.CTA, T1.FECHA, T1.DESCRIPCION,
    T1.PLAZA, T1.NRO_OPER, T1.CARGO, T1.ABONO, T1.SD, T1.COMP, T1.TIPO,
    T1.TIENDA, T1.RUC, T1.RAZON_SOCIAL_CLIENTE, T1.UBICACION, T1.DIRECCION, T1.OBSERVACION
)
SELECT
  TCORTADO.ID,
  TCORTADO.CUO,
  TCORTADO.CUOA,
  TCORTADO.BANCO,
  TCORTADO.CTA,
  TCORTADO.FECHA,
  TCORTADO.DESCRIPCION,
  TCORTADO.PLAZA,
  TCORTADO.NRO_OPER,
  TCORTADO.CARGO,
  TCORTADO.ABONO,
  TCORTADO.SD,
  TCORTADO.COMP,
  TCORTADO.TIPO,
  TCORTADO.AGENCIA,
  TCORTADO.RUC,
  TCORTADO.RAZON,
  TCORTADO.UBICACION,
  TCORTADO.DIRECCION,
  TCORTADO.REG,
  TCORTADO.REGISTRO,
  CAST(ROUND(TCORTADO.ABONO - TCORTADO.CARGO - TCORTADO.REG, 2) AS DECIMAL(18,2)) AS DIF,
  DB.Sucursal,
  DB.Contacto,
  DB.ValidadoPor,
  DB.FechaRecibido,
  DB.UrlVoucher,
  DB.TelefonoContacto,
  TCORTADO.OBSERVACION AS Observacion
FROM TCORTADO
LEFT JOIN Creditos.dbo.DepositosBanco DB WITH (NOLOCK)
  ON DB.MCUO = TCORTADO.CUO
 AND DB.Empresa = @empresaNombre
WHERE ABS(ROUND(TCORTADO.ABONO - TCORTADO.CARGO - TCORTADO.REG, 2)) > 0.00
  AND (
    @searchTerm IS NULL OR
    CONVERT(NVARCHAR(50), TCORTADO.CUO) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.CUOA) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.BANCO) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.CTA) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.NRO_OPER) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.DESCRIPCION) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.PLAZA) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.AGENCIA) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.RAZON) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.RUC) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), TCORTADO.OBSERVACION) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), DB.Sucursal) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), DB.Contacto) LIKE @searchTerm OR
    CONVERT(NVARCHAR(50), DB.TelefonoContacto) LIKE @searchTerm
  )
ORDER BY TCORTADO.FECHA DESC, TCORTADO.BANCO ASC, TCORTADO.CUO ASC
OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
  `;

  return runLoggedSqlServerQuery(
    "movimientos.porIdentificar",
    {
      empresa,
      empresaNombre: resolvedEmpresaNombre,
      fechaInicio: startDate,
      fechaFin: endDate,
      searchTerm: normalizedSearch,
      limit: normalizedLimit,
      offset: normalizedOffset,
    },
    async () => {
      const result = await request.query(queryText);
      return result.recordset || [];
    }
  );
}

async function fetchCortadoVsRegistrosSqlServer({
  empresa,
  empresaNombre,
  period,
  searchTerm,
  nroOperacion = "",
  banco = "",
  fecha = "",
  importe = "",
  limit = 250,
  offset = 0,
}) {
  const pool = await getSqlServerPool();
  if (!pool) {
    throw new Error("SQL Server no est\u00e1 configurado en el backend");
  }

  const empresaSuffix = resolveSqlServerEmpresaSuffix(empresa);
  const resolvedEmpresaNombre = resolveSqlServerEmpresaNombre(empresa, empresaNombre);
  const normalizedLimit = Math.min(Math.max(Number(limit) || 250, 1), 2000);
  const normalizedOffset = Math.max(Number(offset) || 0, 0);
  const normalizedSearch = String(searchTerm || "").trim();
  const searchPattern = normalizedSearch ? `%${normalizedSearch}%` : null;
  const normalizedNroOperacion = String(nroOperacion || "").trim();
  const normalizedBanco = String(banco || "").trim();
  const normalizedFecha = normalizeDateOnly(fecha);
  const normalizedImporte = String(importe || "").trim();
  const periodRange = resolvePeriodMonthRange(period);

  if (!periodRange) {
    const error = new Error("Debes ingresar un periodo válido en formato YYYYMM");
    error.statusCode = 400;
    throw error;
  }

  const request = pool.request();
  request.input("empresaNombre", sql.NVarChar(150), resolvedEmpresaNombre);
  request.input("fechaInicio", sql.Date, new Date(`${periodRange.startDate}T00:00:00`));
  request.input("fechaFin", sql.Date, new Date(`${periodRange.endDate}T00:00:00`));
  request.input("searchTerm", sql.NVarChar(sql.MAX), searchPattern);
  request.input("nroOperacion", sql.NVarChar(100), normalizedNroOperacion || null);
  request.input("banco", sql.NVarChar(150), normalizedBanco || null);
  request.input("fecha", sql.Date, normalizedFecha ? new Date(`${normalizedFecha}T00:00:00`) : null);
  request.input("importe", sql.Decimal(18, 2), normalizedImporte ? Number(normalizedImporte) : null);
  request.input("limit", sql.Int, normalizedLimit);
  request.input("offset", sql.Int, normalizedOffset);

  const queryText = `
SET NOCOUNT ON;

DECLARE @fechaInicioLocal DATE = @fechaInicio;
DECLARE @fechaFinLocal DATE = @fechaFin;
DECLARE @searchPattern NVARCHAR(MAX) = @searchTerm;
DECLARE @nroOperacionFilter NVARCHAR(100) = @nroOperacion;
DECLARE @bancoFilter NVARCHAR(150) = @banco;
DECLARE @fechaFilter DATE = @fecha;
DECLARE @importeFilter DECIMAL(18, 2) = @importe;

IF @fechaInicioLocal IS NULL OR @fechaFinLocal IS NULL
BEGIN
  RAISERROR('Debes ingresar un periodo válido en formato YYYYMM', 16, 1);
  RETURN;
END;

SELECT
    ID, CUO, PERIODO, BANCO, FECHA, DESCRIPCION,
    NRO_OPER, CARGO, ABONO, SD, COMP, TIPO, DOC, AREA, Observacion
INTO #TempCortado
FROM Creditos.dbo.CORTADO${empresaSuffix} WITH (NOLOCK)
WHERE FECHA BETWEEN @fechaInicioLocal AND @fechaFinLocal;

CREATE INDEX IX_TempCortado_CUO ON #TempCortado(CUO);

WITH TCORTADO AS (
    SELECT
        R.ID, R.PERIODO, R.BANCO, R.CUO, R.FECHA, R.DESCRIPCION,
        R.NRO_OPER, R.CARGO, R.ABONO, R.SD, R.COMP, R.TIPO,
        ISNULL(T.REGISTRO, '') AS REGISTRO,
        ISNULL(T.GLOSA, '') AS GLOSA,
        T.REG,
        (R.ABONO - R.CARGO - ISNULL(T.REG, 0)) AS DIF,
        R.DOC, R.AREA, R.Observacion
    FROM #TempCortado R
    LEFT JOIN (
        SELECT
            MCUO,
            CASE WHEN COUNT(DISTINCT REGISTRO) > 1 THEN 'VARIOS' ELSE MAX(REGISTRO) END AS REGISTRO,
            CASE WHEN COUNT(DISTINCT DESCRIPCION) > 1 THEN 'VARIOS' ELSE MAX(DESCRIPCION) END AS GLOSA,
            SUM(IMPORTE) AS REG
        FROM Creditos.dbo.RegistrosConcar${empresaSuffix} WITH (NOLOCK)
        WHERE ESTADO <> 'ELIMINADO'
          AND FECHAREP BETWEEN @fechaInicioLocal AND @fechaFinLocal
        GROUP BY MCUO
    ) T ON T.MCUO = R.CUO
),
FILTRADO AS (
    SELECT
        T.*,
        COUNT(*) OVER() AS TOTAL_COUNT,
        ROW_NUMBER() OVER (ORDER BY T.FECHA, T.BANCO, T.CUO, T.ID) AS RN
    FROM TCORTADO T
    WHERE
      (
      @searchPattern IS NULL
      OR CONVERT(NVARCHAR(50), T.NRO_OPER) LIKE @searchPattern
      OR CONVERT(NVARCHAR(50), T.CUO) LIKE @searchPattern
      OR CONVERT(NVARCHAR(150), T.BANCO) LIKE @searchPattern
      OR CONVERT(NVARCHAR(250), T.DESCRIPCION) LIKE @searchPattern
      OR CONVERT(NVARCHAR(50), T.ABONO) LIKE @searchPattern
      OR CONVERT(NVARCHAR(150), T.REGISTRO) LIKE @searchPattern
      OR CONVERT(NVARCHAR(250), T.GLOSA) LIKE @searchPattern
      )
    AND (
      @nroOperacionFilter IS NULL
      OR CONVERT(NVARCHAR(50), T.NRO_OPER) LIKE '%' + @nroOperacionFilter + '%'
      OR CONVERT(NVARCHAR(50), T.CUO) LIKE '%' + @nroOperacionFilter + '%'
    )
    AND (
      @bancoFilter IS NULL
      OR CONVERT(NVARCHAR(150), T.BANCO) LIKE '%' + @bancoFilter + '%'
    )
    AND (
      @fechaFilter IS NULL
      OR CONVERT(DATE, T.FECHA) = @fechaFilter
    )
    AND (
      @importeFilter IS NULL
      OR ABS(ROUND(ISNULL(T.ABONO, 0), 2) - ROUND(@importeFilter, 2)) < 0.01
    )
)
SELECT
    ID, PERIODO, BANCO, CUO, FECHA, DESCRIPCION,
    NRO_OPER, CARGO, ABONO, SD, COMP, TIPO,
    REGISTRO, GLOSA, REG, DIF, DOC, AREA, Observacion,
    TOTAL_COUNT
FROM FILTRADO
WHERE RN > @offset AND RN <= (@offset + @limit)
ORDER BY RN;

DROP TABLE #TempCortado;
  `;

  if (QUERY_LOGGING_ENABLED) {
    console.log("[MSSQL] QUERY cortado.vsRegistros", {
      empresa: String(empresa),
      empresaNombre: resolvedEmpresaNombre,
      period: String(period || "").trim(),
      fechaInicio: periodRange.startDate,
      fechaFin: periodRange.endDate,
      nroOperacion: normalizedNroOperacion || null,
      banco: normalizedBanco || null,
      fecha: normalizedFecha || null,
      importe: normalizedImporte || null,
      queryText,
    });
  }

  return runLoggedSqlServerQuery(
    "cortado.vsRegistros",
    {
      empresa,
      empresaNombre: resolvedEmpresaNombre,
      period,
      searchTerm: normalizedSearch,
      nroOperacion: normalizedNroOperacion || null,
      banco: normalizedBanco || null,
      fecha: normalizedFecha || null,
      importe: normalizedImporte || null,
      fechaInicio: periodRange.startDate,
      fechaFin: periodRange.endDate,
      limit: normalizedLimit,
      offset: normalizedOffset,
    },
    async () => {
      const result = await request.query(queryText);
      const rows = result.recordset || [];
      const totalCount = rows.length ? Number(rows[0].TOTAL_COUNT || rows.length) : 0;
      return {
        rows,
        totalCount,
      };
    }
  );
}

async function updateCortadoTipoSqlServer({ empresa, empresaNombre, id, tipo }) {
  const pool = await getSqlServerPool();
  if (!pool) {
    throw new Error("SQL Server no está configurado en el backend");
  }

  const empresaSuffix = resolveSqlServerEmpresaSuffix(empresa);
  const resolvedEmpresaNombre = resolveSqlServerEmpresaNombre(empresa, empresaNombre);
  const normalizedId = Number(id);
  const normalizedTipo = String(tipo || "").trim();

  if (!Number.isFinite(normalizedId)) {
    const error = new Error("ID inválido para actualizar CORTADO");
    error.statusCode = 400;
    throw error;
  }

  if (!normalizedTipo) {
    const error = new Error("TIPO es requerido para actualizar CORTADO");
    error.statusCode = 400;
    throw error;
  }

  const request = pool.request();
  request.input("id", sql.Int, normalizedId);
  request.input("tipo", sql.NVarChar(250), normalizedTipo);

  const queryText = `
UPDATE Creditos.dbo.CORTADO${empresaSuffix}
SET TIPO = @tipo
WHERE ID = @id;

SELECT @@ROWCOUNT AS affectedRows;
  `;

  return runLoggedSqlServerQuery(
    "cortado.updateTipo",
    {
      empresa,
      empresaNombre: resolvedEmpresaNombre,
      id: normalizedId,
      tipo: normalizedTipo,
    },
    async () => {
      const result = await request.query(queryText);
      const affectedRows = Number(result.recordset?.[0]?.affectedRows || 0);
      return {
        affectedRows,
        id: normalizedId,
        tipo: normalizedTipo,
      };
    }
  );
}

function resolvePeriodDateRange(period) {
  if (!period) return null;

  const now = new Date();

  if (period.startsWith("month:")) {
    const [year, month] = period.split(":")[1].split("-").map(Number);
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0);
    return {
      startDate: startOfMonth.toISOString().split("T")[0],
      endDate: endOfMonth.toISOString().split("T")[0],
    };
  }

  switch (period) {
    case "today":
      return {
        startDate: now.toISOString().split("T")[0],
        endDate: now.toISOString().split("T")[0],
      };
    case "week": {
      const dayOfWeek = now.getDay();
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - daysFromMonday);
      startOfWeek.setHours(0, 0, 0, 0);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      endOfWeek.setHours(23, 59, 59, 999);
      return {
        startDate: startOfWeek.toISOString().split("T")[0],
        endDate: endOfWeek.toISOString().split("T")[0],
      };
    }
    case "month": {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return {
        startDate: startOfMonth.toISOString().split("T")[0],
        endDate: endOfMonth.toISOString().split("T")[0],
      };
    }
    default:
      return null;
  }
}

function registerJsonRoutes(app) {
  app.use("/api", (req, res, next) => {
    applyApiCors(req, res);

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    return next();
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: "email y password son requeridos" });
      }

      const authClient = getSupabaseAuthClient();
      if (!authClient) {
        return res.status(503).json({ error: "Supabase no estÃ¡ configurado en el backend" });
      }

      const { data, error } = await authClient.auth.signInWithPassword({ email, password });
      if (error) throw error;

      res.json({ data });
    } catch (error) {
      res.status(401).json({ error: error.message });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { email, password, fullName } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: "email y password son requeridos" });
      }

      const authClient = getSupabaseAuthClient();
      if (!authClient) {
        return res.status(503).json({ error: "Supabase no estÃ¡ configurado en el backend" });
      }

      const { data, error } = await authClient.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName || email.split("@")[0],
          },
        },
      });

      if (error) throw error;
      res.status(201).json({ data });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/me", async (req, res) => {
    try {
      const token =
        req.body?.accessToken ||
        (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!token) {
        return res.status(401).json({ error: "accessToken es requerido" });
      }

      const authClient = getSupabaseAuthClient();
      if (!authClient) {
        return res.status(503).json({ error: "Supabase no estÃ¡ configurado en el backend" });
      }

      const { data, error } = await authClient.auth.getUser(token);
      if (error) throw error;

      res.json({ data });
    } catch (error) {
      res.status(401).json({ error: error.message });
    }
  });

  app.post("/api/auth/password", async (req, res) => {
    try {
      const { accessToken, refreshToken, password } = req.body || {};
      if (!accessToken || !refreshToken || !password) {
        return res.status(400).json({ error: "accessToken, refreshToken y password son requeridos" });
      }

      const authClient = getSupabaseAuthClient();
      if (!authClient) {
        return res.status(503).json({ error: "Supabase no estÃ¡ configurado en el backend" });
      }

      const { data: sessionData, error: sessionError } = await authClient.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (sessionError) throw sessionError;

      const { data, error } = await authClient.auth.updateUser({ password });
      if (error) throw error;

      res.json({ data: { session: sessionData.session, user: data.user } });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/auth/logout", async (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/ycloud/configs", async (_req, res) => {
    try {
      const data = await fetchActiveYCloudConfigs();
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/ycloud/configs/active", async (_req, res) => {
    try {
      const data = await fetchActiveYCloudConfigs();
      res.json({ data: data.filter((config) => config.activo) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/ycloud/configs", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const configData = { ...(req.body || {}) };

      if (configData.activo) {
        await runLoggedQuery("ycloud.configs.deactivateOthers", {}, () =>
          client.from("ycloud_config").update({ activo: false }).eq("activo", true)
        );
      }

      const { data, error } = await runLoggedQuery(
        "ycloud.configs.create",
        { alias: configData.alias, activo: configData.activo },
        () => client.from("ycloud_config").insert(configData).select("*").single()
      );

      if (error) throw error;
      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/ycloud/configs/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const configData = { ...(req.body || {}) };

      if (configData.activo) {
        await runLoggedQuery("ycloud.configs.deactivateOthers", {}, () =>
          client
            .from("ycloud_config")
            .update({ activo: false })
            .eq("activo", true)
            .neq("id", req.params.id)
        );
      }

      const { data, error } = await runLoggedQuery(
        "ycloud.configs.update",
        { id: req.params.id, alias: configData.alias, activo: configData.activo },
        () =>
          client
            .from("ycloud_config")
            .update(configData)
            .eq("id", req.params.id)
            .select("*")
            .single()
      );

      if (error) throw error;
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/ycloud/configs/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { error } = await runLoggedQuery(
        "ycloud.configs.delete",
        { id: req.params.id },
        () => client.from("ycloud_config").delete().eq("id", req.params.id)
      );
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/ycloud/test-connection", async (req, res) => {
    try {
      const { configId } = req.body || {};
      if (!configId) {
        return res.status(400).json({ error: "configId es requerido" });
      }

      const config = await fetchYCloudConfigById(configId);
      const response = await fetch(YCLOUD_BALANCE_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-API-Key": config.api_key,
        },
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          error: data.error?.message || response.statusText,
          details: data,
        });
      }

      res.json({
        success: true,
        data,
        message: `ConexiÃ³n exitosa con YCloud. Balance: ${data.amount ?? "N/A"} ${data.currency ?? ""}`.trim(),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/ycloud/send", async (req, res) => {
    try {
      const trace = `ycloud.send:${req.body?.configId || "no-config"}:${Date.now()}`;
      console.time(trace);
      console.log("[YCLOUD] /send recibido", {
        to: req.body?.to || null,
        type: req.body?.type || null,
        hasReplyToMessageId: !!req.body?.replyToMessageId,
      });
      console.timeLog(trace, "enviando a YCloud");
      const data = await sendYCloudMessage(req.body || {});
      console.timeLog(trace, "respuesta YCloud recibida", {
        messageId: data?.messages?.[0]?.id || data?.id || null,
      });
      res.json({
        success: true,
        data,
        message: "Mensaje enviado exitosamente via YCloud",
        logInserted: null,
        logQueued: true,
      });

      void (async () => {
        try {
          const client = getSupabaseAdminClient();
          const payloadContext = data?.__payload?.context || req.body?.context || null;
          console.timeLog(trace, "iniciando guardado en whatsapp_mensajes_log");
          const { logInserted, logError } = await logYCloudOutboundMessage(
            client,
            req.body || {},
            data,
            {
              metadata: {
                context: payloadContext,
                reply_to_wamid: payloadContext?.wamid || payloadContext?.message_id || null,
                reply_to_text: payloadContext?.body || payloadContext?.text || null,
                reply_to_direction: payloadContext?.direction || null,
              },
            }
          );

          let finalLogInserted = logInserted;
          let finalLogError = logError;
          if (client && !finalLogInserted) {
            const fallbackWamid = extractYCloudWamid(data);
            const minimalFallback = await logYCloudOutboundMessageMinimal(
              client,
              {
                ...req.body,
                telefono_destino: normalizeStoredPhone(req.body?.to || null),
                message_id: fallbackWamid,
                wamid: fallbackWamid,
                metadata: {
                  ...(req.body?.metadata || {}),
                  context: payloadContext || null,
                  reply_to_wamid: payloadContext?.wamid || payloadContext?.message_id || null,
                  reply_to_text: payloadContext?.body || payloadContext?.text || null,
                  reply_to_direction: payloadContext?.direction || null,
                },
              }
            );
            finalLogInserted = minimalFallback.logInserted;
            finalLogError = minimalFallback.logError || finalLogError;
          }
          if (!finalLogInserted) {
            console.warn("[YCLOUD] Mensaje enviado pero no se pudo guardar en whatsapp_mensajes_log:", finalLogError);
          }
        } catch (backgroundError) {
          console.warn("[YCLOUD] Falló el guardado asíncrono del log outbound:", backgroundError.message);
        }
      })();
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/ycloud/test", async (req, res) => {
    try {
      const { configId, to } = req.body || {};
      if (!configId || !to) {
        return res.status(400).json({ success: false, error: "configId y to son requeridos" });
      }

      const data = await sendYCloudMessage({
        configId,
        to,
        type: "text",
        text: {
          body: `Mensaje de prueba desde YCloud\n\nHora: ${new Date().toLocaleString()}\nSistema: Backend persistente\nEstado: Conectado correctamente`,
          previewUrl: false,
        },
      });
      res.json({
        success: true,
        data,
        message: "Mensaje de prueba enviado exitosamente",
        logInserted: null,
        logQueued: true,
      });

      void (async () => {
        try {
          const client = getSupabaseAdminClient();
          const { logInserted, logError } = await logYCloudOutboundMessage(
            client,
            {
              configId,
              to,
              type: "text",
              text: {
                body: `Mensaje de prueba desde YCloud\n\nHora: ${new Date().toLocaleString()}\nSistema: Backend persistente\nEstado: Conectado correctamente`,
                previewUrl: false,
              },
            },
            data,
            {
              metadata: {
                context: data?.__payload?.context || null,
                reply_to_wamid: data?.__payload?.context?.wamid || data?.__payload?.context?.message_id || null,
                reply_to_text: data?.__payload?.context?.body || data?.__payload?.context?.text || null,
                reply_to_direction: data?.__payload?.context?.direction || null,
              },
            },
          );
          let finalLogInserted = logInserted;
          let finalLogError = logError;
          if (client && !finalLogInserted) {
            const fallbackWamid = extractYCloudWamid(data);
            const minimalFallback = await logYCloudOutboundMessageMinimal(client, {
              configId,
              to,
              type: "text",
              text: {
                body: `Mensaje de prueba desde YCloud\n\nHora: ${new Date().toLocaleString()}\nSistema: Backend persistente\nEstado: Conectado correctamente`,
                previewUrl: false,
              },
              telefono_destino: normalizeStoredPhone(to || null),
              message_id: fallbackWamid,
              wamid: fallbackWamid,
              metadata: {
                context: data?.__payload?.context || null,
                reply_to_wamid: data?.__payload?.context?.wamid || data?.__payload?.context?.message_id || null,
                reply_to_text: data?.__payload?.context?.body || data?.__payload?.context?.text || null,
                reply_to_direction: data?.__payload?.context?.direction || null,
              },
            });
            finalLogInserted = minimalFallback.logInserted;
            finalLogError = minimalFallback.logError || finalLogError;
          }
          if (!finalLogInserted) {
            console.warn("[YCLOUD] Mensaje de prueba enviado pero no se pudo guardar en whatsapp_mensajes_log:", finalLogError);
          }
        } catch (backgroundError) {
          console.warn("[YCLOUD] Falló el guardado asíncrono del log de prueba:", backgroundError.message);
        }
      })();
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/ycloud/conversation", async (req, res) => {
    try {
      const { depositId, phoneNumber, startDate, endDate, before, limit = 100 } = req.body || {};
      let normalizedPhone = normalizeConversationPhone(phoneNumber);

      if (!normalizedPhone && depositId) {
        normalizedPhone = await resolveConversationPhoneFromDepositId(depositId);
      }

      if (!normalizedPhone) {
        return res.status(400).json({ success: false, error: "phoneNumber o depositId es requerido" });
      }

      const client = getSupabaseAdminClient();
      if (!client) {
        return res.status(503).json({ success: false, error: "Supabase no está configurado en el backend", messages: [] });
      }

      const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
      const phoneVariants = buildConversationPhoneVariants(normalizedPhone);
      const defaultConversationStartIso = (() => {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        return d.toISOString();
      })();
      const conversationStartIso = startDate || defaultConversationStartIso;
      const conversationEndIso = endDate || null;
      const cursorBeforeIso = before || null;

      let storedQuery = client
        .from("whatsapp_mensajes_log")
        .select("*")
        .or(
          [
            ...phoneVariants.map((variant) => `telefono_destino.eq.${variant}`),
            ...phoneVariants.map((variant) => `conversation_key.eq.${variant}`),
          ].join(",")
        )
        .gte("enviado_en", conversationStartIso)
        .order("enviado_en", { ascending: false, nullsFirst: false })
        .limit(safeLimit);

      if (conversationEndIso) {
        storedQuery = storedQuery.lte("enviado_en", conversationEndIso);
      }

      if (cursorBeforeIso) {
        storedQuery = storedQuery.lt("enviado_en", cursorBeforeIso);
      }

      const storedResult = await runLoggedQuery(
        "whatsapp.conversation.stored",
        {
          phoneNumber: normalizedPhone,
          phoneVariants,
          limit: safeLimit,
          depositId: depositId || null,
          startDate: conversationStartIso,
          endDate: conversationEndIso,
          before: cursorBeforeIso,
        },
        () => storedQuery
      );

      if (storedResult.error) {
        throw new Error(storedResult.error.message);
      }

      const storedMessages = (storedResult.data || []).map(normalizeStoredConversationMessage);
      const deduped = [];
      const seen = new Set();

      for (const message of storedMessages) {
        const key = [
          message.id || message.externalId || "",
          message.timestamp || "",
          message.direction || "",
          message.content || message.text || "",
          message.attachmentUrl || "",
        ].join("|");

        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(message);
      }

      const getMessageTime = (message) =>
        new Date(message.timestamp || message.createdAt || 0).getTime();

      const recentMessages = deduped
        .sort((a, b) => getMessageTime(a) - getMessageTime(b));

      res.json({
        success: true,
        message: `Se encontraron ${recentMessages.length} mensajes`,
        messages: recentMessages,
        totalCount: recentMessages.length,
        filteredCount: recentMessages.length,
        sourceSummary: {
          storedCount: storedMessages.length,
          remoteCount: 0,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message, messages: [] });
    }
  });

  app.get("/api/ycloud/webhook", async (req, res) => {
    try {
      const mode = String(req.query["hub.mode"] || req.query.mode || "").trim();
      const challenge = req.query["hub.challenge"] || req.query.challenge;
      const token = String(req.query["hub.verify_token"] || req.query.verify_token || "").trim();
      const config = await fetchActiveYCloudConfig().catch(() => null);
      const expectedToken = String(config?.verify_token || process.env.YCLOUD_VERIFY_TOKEN || "").trim();

      if (mode === "subscribe" && challenge && expectedToken && token === expectedToken) {
        return res.status(200).send(String(challenge));
      }

      if (!expectedToken && challenge) {
        return res.status(200).send(String(challenge));
      }

      return res.status(403).json({ success: false, error: "Webhook verification fallida" });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/ycloud/webhook", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      if (!client) {
        return res.status(503).json({ success: false, error: "Supabase no está configurado en el backend" });
      }

      const payload = req.body || {};
      const webhookMessages = extractConversationMessages(payload);
      const storedRows = [];

      for (const message of webhookMessages) {
        const phoneNumber = extractWebhookPhoneNumber(message, payload);
        const { attachmentType, attachmentUrl, attachmentName } = extractWebhookAttachment(message);
        const messageId = extractWebhookMessageId(message, payload);
        const receivedAt = message?.createTime || message?.sendTime || message?.timestamp || payload?.timestamp || new Date().toISOString();

        let storedMedia = null;
        if (attachmentUrl) {
          try {
            storedMedia = await uploadWhatsAppMediaToStorage(client, attachmentUrl, {
              phoneNumber,
              messageId: messageId || "",
              attachmentType,
              attachmentName,
              mimeType: message?.image?.mimeType || message?.document?.mimeType || message?.video?.mimeType || message?.audio?.mimeType || "",
            });
          } catch (mediaError) {
            console.warn("No se pudo guardar el adjunto de WhatsApp en Storage:", mediaError.message);
          }
        }

        const row = {
          telefono_destino: normalizeStoredPhone(phoneNumber || message?.to || message?.from || ""),
          tipo_mensaje: message?.type || attachmentType || "text",
          contenido: message,
          message_id: messageId,
          estado: "recibido",
          error_mensaje: null,
          metadata: {
            direction: "inbound",
            source: "ycloud-webhook",
            phoneNumber,
            from: message?.from || payload?.from || null,
            to: message?.to || payload?.to || null,
            rawPayload: payload,
            messagePayload: message,
            context: message?.context || null,
            reply_to_message_id: message?.context?.message_id || message?.context?.id || null,
            attachment_url: storedMedia?.publicUrl || attachmentUrl || null,
            attachment_path: storedMedia?.path || null,
            attachment_name: storedMedia?.attachmentName || attachmentName || null,
            attachment_type: attachmentType || null,
          },
          direction: "inbound",
          source: "ycloud-webhook",
          conversation_key: phoneNumber || normalizeConversationPhone(message?.to || message?.from || ""),
          attachment_url: storedMedia?.publicUrl || attachmentUrl || null,
          attachment_name: storedMedia?.attachmentName || attachmentName || null,
          attachment_mime_type: storedMedia?.contentType || message?.image?.mimeType || message?.document?.mimeType || message?.video?.mimeType || message?.audio?.mimeType || null,
          storage_bucket: storedMedia?.bucket || null,
          storage_path: storedMedia?.path || null,
          enviado_en: receivedAt,
        };

        if (messageId) {
          const existing = await runLoggedQuery(
            "whatsapp.webhook.exists",
            { messageId },
            () => client.from("whatsapp_mensajes_log").select("id").eq("message_id", messageId).maybeSingle()
          );

          if (!existing.error && existing.data) {
            continue;
          }
        }

        const insertResult = await runLoggedQuery(
          "whatsapp.webhook.insert",
          { messageId, phoneNumber },
          () => client.from("whatsapp_mensajes_log").insert(row).select("*").maybeSingle()
        );

        if (insertResult.error) {
          throw new Error(insertResult.error.message);
        }

        storedRows.push(insertResult.data || row);
      }

      res.json({
        success: true,
        processed: storedRows.length,
        messages: storedRows,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/whatsapp/credentials", async (_req, res) => {
    try {
      const credentials = await fetchWhatsAppCredentials();
      res.json({ data: credentials || null });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/whatsapp/send", async (req, res) => {
    try {
      const responseData = await sendWhatsAppMessage(req.body || {});
      const client = getSupabaseAdminClient();
      let logResult = null;
      let logError = null;
      if (client) {
        try {
          logResult = await logWhatsAppMessage(client, {
          telefono_destino: normalizeStoredPhone(req.body?.to || null),
          tipo_mensaje: req.body?.type || "text",
          contenido: req.body || {},
          estado: "enviado",
          enviado_en: new Date().toISOString(),
          message_id: responseData.messages?.[0]?.id || responseData.id || null,
          direction: "outbound",
          source: "whatsapp-graph",
          conversation_key: normalizeConversationPhone(req.body?.to || ""),
          configuracion_id: req.body?.configId || null,
          metadata: {
            direction: "outbound",
            source: "whatsapp-graph",
            to: req.body?.to || null,
          },
        });
        } catch (error) {
          logError = error.message;
          console.warn("No se pudo persistir el log outbound de WhatsApp:", error.message);
        }
      }

      res.json({
        success: true,
        data: responseData,
        logInserted: !!logResult,
        logError,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/whatsapp/log", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      if (!client) {
        return res.status(503).json({ error: "Supabase no estÃ¡ configurado en el backend" });
      }

      const { data, error } = await client
        .from("whatsapp_mensajes_log")
        .insert(req.body || {})
        .select("*")
        .single();

      if (error) throw error;
      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/support-requests", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      if (!client) {
        return res.status(503).json({ error: "Supabase no esta configurado en el backend" });
      }

      const status = String(req.query.status || "").trim().toLowerCase();
      const limit = Math.min(Number(req.query.limit || 50), 200);
      const todayLima = getLimaDateOnly();
      const todayRange = buildLimaDayRange(todayLima);

      let query = client
        .from("support_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (status) {
        query = query.eq("status", status);
      }

      if (status === "pendiente" && todayRange) {
        query = query
          .gte("created_at", todayRange.sinceIso)
          .lt("created_at", todayRange.untilIso);
      }

      const { data, error } = await runLoggedQuery(
        "support_requests.list",
        { status, limit, todayLima, todayOnly: status === "pendiente" },
        () => query
      );

      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/support-requests/analytics", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      if (!client) {
        return res.status(503).json({ error: "Supabase no esta configurado en el backend" });
      }

      const status = String(req.query.status || "pendiente").trim().toLowerCase() || "pendiente";
      const daysRaw = Number(req.query.days || 30);
      const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 180) : 30;
      const timeZone = "America/Lima";

      const untilDate = new Date();
      const sinceDate = new Date(untilDate.getTime() - days * 24 * 60 * 60 * 1000);
      const sinceIso = sinceDate.toISOString();
      const untilIso = untilDate.toISOString();

      const rows = [];
      const batchSize = 500;
      let offset = 0;

      while (true) {
        let query = client
          .from("support_requests")
          .select("id, created_at, status, pending_count, source, requested_by_name, requested_by_role")
          .gte("created_at", sinceIso)
          .lte("created_at", untilIso)
          .order("created_at", { ascending: false })
          .range(offset, offset + batchSize - 1);

        if (status) {
          query = query.eq("status", status);
        }

        const pageResult = await runLoggedQuery(
          "support_requests.analytics.page",
          { status, days, offset, batchSize },
          () => query
        );

        if (pageResult.error) throw pageResult.error;

        const pageRows = Array.isArray(pageResult.data) ? pageResult.data : [];
        rows.push(...pageRows);

        if (pageRows.length < batchSize) {
          break;
        }

        offset += batchSize;
      }

      const hourBuckets = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        label: `${String(hour).padStart(2, "0")}:00`,
        count: 0,
        suggested_support: 0,
      }));

      const hourFormatter = new Intl.DateTimeFormat("es-PE", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const getLocalHour = (dateValue) => {
        const date = new Date(dateValue);
        if (Number.isNaN(date.getTime())) {
          return null;
        }

        const parts = hourFormatter.formatToParts(date);
        const hourPart = parts.find((part) => part.type === "hour");
        const hour = Number(hourPart?.value);
        return Number.isFinite(hour) ? hour : null;
      };

      rows.forEach((row) => {
        const hour = getLocalHour(row.created_at);
        if (hour === null || hour < 0 || hour > 23) {
          return;
        }

        hourBuckets[hour].count += 1;
      });

      hourBuckets.forEach((bucket) => {
        bucket.suggested_support = bucket.count > 0 ? Math.max(1, Math.ceil(bucket.count / 3)) : 0;
      });

      const orderedByPeak = [...hourBuckets]
        .filter((bucket) => bucket.count > 0)
        .sort((a, b) => b.count - a.count || a.hour - b.hour)
        .map((bucket, index) => ({
          ...bucket,
          rank: index + 1,
          percentage: rows.length ? Number(((bucket.count / rows.length) * 100).toFixed(1)) : 0,
        }));

      const peakHour = orderedByPeak[0] || null;
      const peakWindows = orderedByPeak.slice(0, 5);
      const totalRequests = rows.length;
      const averagePerHour = Number((totalRequests / 24).toFixed(2));
      const activeHours = hourBuckets.filter((bucket) => bucket.count > 0).length;
      const criticalHours = hourBuckets.filter((bucket) => bucket.count >= 3).length;

      res.json({
        data: {
          period: {
            status,
            days,
            since: sinceIso,
            until: untilIso,
            timeZone,
          },
          summary: {
            totalRequests,
            averagePerHour,
            activeHours,
            criticalHours,
            peakHour,
            suggestedSupportForPeak: peakHour ? peakHour.suggested_support : 0,
          },
          hourlySeries: hourBuckets,
          peakWindows,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/support-requests", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      if (!client) {
        return res.status(503).json({ error: "Supabase no esta configurado en el backend" });
      }

      const body = req.body || {};
      console.log("[support-requests] POST /api/support-requests", {
        bodyKeys: Object.keys(body || {}),
        requested_by_name: body.requested_by_name || body.user_name || body.userName || null,
        source: body.source || "web",
      });
      const requestedById = String(body.requested_by_id || body.user_id || body.userId || "").trim();
      const requestedByName = String(body.requested_by_name || body.user_name || body.userName || "").trim();
      const reason = String(body.reason || body.motivo || "").trim();
      const pendingCount = Number(body.pending_count || body.pendingCount || 0);

      if (!requestedByName) {
        return res.status(400).json({ error: "requested_by_name es requerido" });
      }

      if (!reason) {
        return res.status(400).json({ error: "reason es requerido" });
      }

      const payload = {
        requested_by_id: requestedById || null,
        requested_by_name: requestedByName,
        requested_by_role: String(body.requested_by_role || body.user_role || body.userRole || "").trim() || null,
        reason,
        pending_count: Number.isFinite(pendingCount) ? pendingCount : 0,
        status: String(body.status || "pendiente").trim() || "pendiente",
        source: String(body.source || "web").trim() || "web",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await runLoggedQuery(
        "support_requests.create",
        { requestedById, requestedByName, pendingCount, status: payload.status },
        () => client.from("support_requests").insert(payload).select("*").single()
      );

      if (error) throw error;

      broadcastSupportRequestChange("INSERT", data, null, { source: "api/support-requests" });

      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/support-requests/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      if (!client) {
        return res.status(503).json({ error: "Supabase no esta configurado en el backend" });
      }

      const requestId = String(req.params.id || "").trim();
      const body = req.body || {};
      console.log("[support-requests] PATCH /api/support-requests/:id", {
        requestId,
        bodyKeys: Object.keys(body || {}),
      });
      const status = String(body.status || "").trim().toLowerCase();
      const acknowledgedBy = String(body.acknowledged_by || body.acknowledgedBy || "").trim();
      const notes = String(body.notes || "").trim();
      const hasBodyContent = body && typeof body === "object" && Object.keys(body).length > 0;

      if (!requestId) {
        return res.status(400).json({ error: "id es requerido" });
      }

      if (!hasBodyContent) {
        return res.status(400).json({ error: "body incompleto" });
      }

      if (!["atendido", "vencido", "vencida"].includes(status)) {
        return res.status(400).json({ error: "status invalido" });
      }

      if (status === "atendido" && !acknowledgedBy) {
        return res.status(400).json({ error: "acknowledged_by es requerido" });
      }

      const result =
        status === "atendido"
          ? await updateSupportRequestAsAcknowledged(client, requestId, acknowledgedBy, {
              notes: notes || "Reconocido desde la app de bandeja",
            })
          : await updateSupportRequestAsExpired(client, requestId, {
              notes: notes || "Vencido por expiración en la app de bandeja",
            });
      if (result.statusCode === 404) {
        return res.status(404).json({ error: result.error });
      }

      broadcastSupportRequestChange("UPDATE", result.data, result.oldData || null, { source: "api/support-requests/:id" });

      res.status(200).json({ data: result.data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/personal/search", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const searchTerm = String(req.query.q || "").trim();
      const limit = Number(req.query.limit || 10);
      const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";

      if (!searchTerm || searchTerm.length < 2) {
        return res.json({ data: [] });
      }

      const { data, error } = await runLoggedQuery(
        "personal.search",
        { searchTerm, limit },
        () => {
          let query = client
            .from("sucursal_personal")
            .select(
              `
              id,
              nombre,
              telefono_origen,
              empresa,
              es_responsable,
              estado,
              sucursal:sucursal_id (
                id,
                nombre,
                telefono
              )
            `
            )
            .or(`nombre.ilike.%${searchTerm}%,telefono_origen.ilike.%${searchTerm}%`)
            .order("nombre")
            .limit(limit);

          if (!includeInactive) {
            query = query.eq("estado", "activo");
          }

          return query;
        }
      );

      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/depositos/check-duplicate", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { monto, moneda, numero_operacion_banco, excludeId } = req.body || {};

      const normalizeCurrencyForDuplicateCheck = (value) => {
        const raw = String(value || "").trim().toUpperCase();
        if (!raw) return "";
        if (raw === "PEN" || raw === "S/" || raw === "S" || raw.includes("SOL")) return "PEN";
        if (raw === "USD" || raw === "$" || raw.includes("DOLAR") || raw.includes("DÓLAR")) return "USD";
        return "";
      };

      const normalizeOperacionForDuplicateCheck = (value) =>
        String(value || "")
          .trim()
          .replace(/\D/g, "")
          .replace(/^0+/, "");

      if (!monto || !moneda || !numero_operacion_banco) {
        return res.status(400).json({
          checked: true,
          isDuplicate: true,
          message: "El importe, moneda y número de operación bancaria son necesarios para la comprobación.",
        });
      }

      const normalizedInputOp = normalizeOperacionForDuplicateCheck(numero_operacion_banco);
      if (!normalizedInputOp) {
        return res.status(400).json({
          checked: true,
          isDuplicate: true,
          message: "El número de operación bancaria no es válido para la comprobación.",
        });
      }

      const duplicateCheckQuery = client
        .from("depositos")
        .select(
          `
          id,
          numero_operacion_banco,
          monto,
          moneda,
          fecha_deposito,
          fecha_registro,
          estado,
          numero_operacion,
          sucursal:sucursal_id(nombre),
          trabajador:trabajador_sucursal_id(nombre),
          empresa:empresa_id(nombre),
          banco:banco_id(nombre, abreviatura)
        `
        )
        .eq("monto", monto)
        .or(
          `numero_operacion_banco.ilike.%${normalizedInputOp},numero_operacion.ilike.%${normalizedInputOp}`
        );

      const normalizedMoneda = normalizeCurrencyForDuplicateCheck(moneda);
      if (normalizedMoneda) {
        duplicateCheckQuery.in("moneda", [normalizedMoneda, normalizedMoneda === "PEN" ? "SOLES (PEN)" : "DÓLARES (USD)"]);
      }

      const normalizedExcludeId =
        typeof excludeId === "string" && excludeId.trim() ? excludeId.trim() : null;

      if (normalizedExcludeId) {
        duplicateCheckQuery.neq("id", normalizedExcludeId);
      }

      const { data, error } = await runLoggedQuery(
        "depositos.duplicateCheck",
        { monto, moneda, numero_operacion_banco, excludeId: normalizedExcludeId },
        () => duplicateCheckQuery
      );

      if (error) throw error;

      const duplicates =
        (data || []).filter((d) => {
          if (d.numero_operacion_banco || d.numero_operacion) {
            const normalizedDbOpBanco = normalizeOperacionForDuplicateCheck(
              d.numero_operacion_banco || d.numero_operacion
            );
            if (normalizedDbOpBanco === normalizedInputOp) return true;
          }

          return false;
        }) || [];

      res.json({
        checked: true,
        isDuplicate: duplicates.length > 0,
        duplicates,
        message:
          duplicates.length > 0
            ? `¡Alerta de Duplicado! Se encontraron ${duplicates.length} depósito(s) con los mismos datos.`
            : "No se encontraron duplicados. Puede confirmar el depósito.",
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/users/:id/profile", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await runLoggedQuery(
        "users.profile.get",
        { userId: req.params.id },
        () => client.from("profiles").select("*").eq("id", req.params.id).single()
      );
      if (error) throw error;
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/users/details", async (req, res) => {
    try {
      const session = await getAuthenticatedUserFromRequest(req);
      if (!session.isAdmin) {
        return res.status(403).json({ error: "Acceso denegado: solo administradores pueden ver usuarios." });
      }

      const client = getSupabaseAdminClient();
      const [authUsersRes, profilesRes] = await Promise.all([
        runLoggedQuery("users.details.auth_users", {}, () =>
          client.auth.admin.listUsers({ page: 1, perPage: 1000 })
        ),
        runLoggedQuery("users.details.profiles", {}, () =>
          client
            .from("profiles")
            .select("id, nombre, usuario, email, rol, estado")
        ),
      ]);

      if (authUsersRes.error) throw authUsersRes.error;
      if (profilesRes.error) throw profilesRes.error;

      const profilesById = new Map((profilesRes.data || []).map((profile) => [String(profile.id), profile]));
      const authUsers = authUsersRes.data?.users || [];

      const data = authUsers.map((authUser) => {
        const profile = profilesById.get(String(authUser.id)) || {};
        return {
          id: authUser.id,
          nombre:
            profile.nombre ||
            authUser.user_metadata?.nombre ||
            authUser.user_metadata?.full_name ||
            authUser.email?.split("@")[0] ||
            "Usuario",
          usuario: profile.usuario || authUser.email || "",
          email: profile.email || authUser.email || "",
          rol: profile.rol || "finanzas",
          user_rol: profile.rol || "finanzas",
          estado: profile.estado || "activo",
          last_sign_in_at: authUser.last_sign_in_at || null,
        };
      });

      res.json({ data });
    } catch (error) {
      res.status(error?.statusCode || 500).json({ error: error.message });
    }
  });

  app.put("/api/users/:id/profile", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await runLoggedQuery(
        "users.profile.update",
        { userId: req.params.id, updates: req.body },
        () =>
          client
            .from("profiles")
            .update(req.body)
            .eq("id", req.params.id)
            .select("*")
            .single()
      );
      if (error) throw error;
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/connection/status", async (_req, res) => {
    try {
      const client = getSupabaseAdminClient();
      if (!client) {
        return res.status(503).json({ ok: false, connected: false });
      }

      const { error } = await runLoggedQuery(
        "connection.status",
        {},
        () => client.from("depositos").select("id").limit(1)
      );
      if (error) throw error;

      res.json({ ok: true, connected: true });
    } catch (error) {
      res.status(500).json({ ok: false, connected: false, error: error.message });
    }
  });

  app.get("/api/dashboard/bootstrap", async (_req, res) => {
    try {
      const data = await fetchBootstrapData();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/bancos", async (_req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await runLoggedQuery("bancos.list", { table: "bancos" }, () =>
        client.from("bancos").select("*").order("nombre", { ascending: true })
      );
      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/empresas", async (_req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await runLoggedQuery("empresas.list", { table: "empresas" }, () =>
        client.from("empresas").select("*").order("nombre", { ascending: true })
      );
      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/cuentas-bancarias", async (_req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await runLoggedQuery("cuentas.list", { table: "cuentas_bancarias" }, () =>
        client
          .from("cuentas_bancarias")
          .select("*, empresa:empresas(*), banco:bancos(*)")
          .order("created_at", { ascending: false })
      );
      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/sucursales", async (_req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await runLoggedQuery("sucursales.list", { table: "sucursales" }, () =>
        client.from("sucursales").select("*").order("nombre", { ascending: true })
      );
      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/sucursales/activity", async (req, res) => {
    try {
      await getAuthenticatedUserFromRequest(req);

      const client = getSupabaseAdminClient();
      const period = String(req.query.period || "month").trim();
      const range = resolvePeriodDateRange(period);

      const [sucursalesRes, depositsRes] = await Promise.all([
        runLoggedQuery("sucursales.activity.list", { period }, () =>
          client
            .from("sucursales")
            .select("id, nombre, estado, telefono")
            .eq("estado", "activa")
            .order("nombre", { ascending: true })
        ),
        runLoggedQuery("sucursales.activity.deposits", { period, range }, () => {
          let query = client
            .from("depositos")
            .select("id, sucursal_id, fecha_solo_date, fecha_registro, estado");

          if (range) {
            query = query
              .gte("fecha_solo_date", range.startDate)
              .lte("fecha_solo_date", range.endDate);
          }

          return query;
        }),
      ]);

      if (sucursalesRes.error) throw sucursalesRes.error;
      if (depositsRes.error) throw depositsRes.error;

      const statsBySucursal = new Map();
      (depositsRes.data || []).forEach((deposit) => {
        const sucursalId = deposit.sucursal_id;
        if (!sucursalId) return;

        const current = statsBySucursal.get(String(sucursalId)) || {
          total_depositos: 0,
          ultimo_deposito: null,
        };

        current.total_depositos += 1;
        const currentDate = deposit.fecha_solo_date || deposit.fecha_registro || null;
        if (
          currentDate &&
          (!current.ultimo_deposito || String(currentDate) > String(current.ultimo_deposito))
        ) {
          current.ultimo_deposito = currentDate;
        }

        statsBySucursal.set(String(sucursalId), current);
      });

      const data = (sucursalesRes.data || []).map((sucursal) => {
        const stats = statsBySucursal.get(String(sucursal.id)) || {
          total_depositos: 0,
          ultimo_deposito: null,
        };

        return {
          ...sucursal,
          total_depositos: stats.total_depositos,
          ultimo_deposito: stats.ultimo_deposito,
          sin_depositos: stats.total_depositos === 0,
        };
      });

      const sortedByLowActivity = [...data].sort((a, b) => {
        const totalDiff = Number(a.total_depositos || 0) - Number(b.total_depositos || 0);
        if (totalDiff !== 0) return totalDiff;

        const aDate = a.ultimo_deposito ? new Date(a.ultimo_deposito).getTime() : 0;
        const bDate = b.ultimo_deposito ? new Date(b.ultimo_deposito).getTime() : 0;
        return aDate - bDate;
      });

      const sinDepositos = sortedByLowActivity.filter((sucursal) => sucursal.total_depositos === 0);
      const menosDe10Depositos = sortedByLowActivity.filter((sucursal) => Number(sucursal.total_depositos || 0) < 10);

      res.json({
        period,
        total: data.length,
        sinDepositosCount: sinDepositos.length,
        menosDe10DepositosCount: menosDe10Depositos.length,
        data,
        sinDepositos,
        menosDe10Depositos,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get("/api/personal", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const limit = req.query.limit ? Number(req.query.limit) : 2000;
      const includeInactive = String(req.query.includeInactive || "").toLowerCase() === "1" ||
        String(req.query.includeInactive || "").toLowerCase() === "true";

      let query = client
        .from("sucursal_personal")
        .select("*, sucursales:sucursal_id(*)")
        .order("nombre", { ascending: true })
        .limit(limit);

      if (!includeInactive) {
        query = query.eq("estado", "activo");
      }

      const { data, error } = await runLoggedQuery(
        "personal.list",
        { table: "sucursal_personal", limit, includeInactive },
        () => query
      );

      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/depositos", async (req, res) => {
    try {
      const ids = String(req.query.ids || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      const data = await fetchDeposits({
        date: req.query.date || undefined,
        period: req.query.period || undefined,
        ids: ids.length > 0 ? ids : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 500,
        regularized: req.query.regularized === "1" || req.query.regularized === "true",
      });
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/sqlserver/movimientos-por-identificar", async (req, res) => {
    try {
      const empresa = req.query.empresa || "1";
      const empresaNombre = req.query.empresaNombre || "";
      const fechaInicio = req.query.fechaInicio || undefined;
      const fechaFin = req.query.fechaFin || undefined;
      const searchTerm = req.query.searchTerm || req.query.search || "";
      const limit = req.query.limit ? Number(req.query.limit) : 250;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      const { data, error } = await fetchMovimientosPorIdentificarSqlServer({
        empresa,
        empresaNombre,
        fechaInicio,
        fechaFin,
        searchTerm,
        limit,
        offset,
      });

      if (error) throw error;

      res.json({
        data: data || [],
        meta: {
          empresa: String(empresa),
          empresaNombre: resolveSqlServerEmpresaNombre(empresa, empresaNombre),
          fechaInicio: normalizeDateOnly(fechaInicio) || null,
          fechaFin: normalizeDateOnly(fechaFin) || null,
          limit: Math.min(Math.max(Number(limit) || 250, 1), 2000),
          offset: Math.max(Number(offset) || 0, 0),
          count: Array.isArray(data) ? data.length : 0,
        },
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({ error: error.message });
    }
  });

  app.get("/api/sqlserver/cortado-vs-registros", async (req, res) => {
    try {
      const empresa = req.query.empresa || "1";
      const empresaNombre = req.query.empresaNombre || "";
      const period = req.query.period || req.query.perfil || req.query.periodo || "";
      const searchTerm = req.query.searchTerm || req.query.search || "";
      const nroOperacion = req.query.nroOperacion || req.query.nro_operacion || "";
      const banco = req.query.banco || "";
      const fecha = req.query.fecha || "";
      const importe = req.query.importe || "";
      const limit = req.query.limit ? Number(req.query.limit) : 250;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      const { data, error } = await fetchCortadoVsRegistrosSqlServer({
        empresa,
        empresaNombre,
        period,
        searchTerm,
        nroOperacion,
        banco,
        fecha,
        importe,
        limit,
        offset,
      });

      if (error) throw error;

      res.json({
        data: data?.rows || [],
        meta: {
          empresa: String(empresa),
          empresaNombre: resolveSqlServerEmpresaNombre(empresa, empresaNombre),
          period: String(period || "").trim() || null,
          searchTerm: String(searchTerm || "").trim() || null,
          nroOperacion: String(nroOperacion || "").trim() || null,
          banco: String(banco || "").trim() || null,
          fecha: normalizeDateOnly(fecha) || null,
          importe: String(importe || "").trim() || null,
          limit: Math.min(Math.max(Number(limit) || 250, 1), 2000),
          offset: Math.max(Number(offset) || 0, 0),
          count: Array.isArray(data?.rows) ? data.rows.length : 0,
          totalCount: Number(data?.totalCount || 0),
        },
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({ error: error.message });
    }
  });

  app.post("/api/sqlserver/cortado-asignar-tipo", async (req, res) => {
    try {
      const empresa = req.body?.empresa || "1";
      const empresaNombre = req.body?.empresaNombre || "";
      const id = req.body?.id;
      const tipo = req.body?.tipo || "";

      const { data, error } = await updateCortadoTipoSqlServer({
        empresa,
        empresaNombre,
        id,
        tipo,
      });

      if (error) throw error;

      res.json({
        data,
        meta: {
          empresa: String(empresa),
          empresaNombre: resolveSqlServerEmpresaNombre(empresa, empresaNombre),
        },
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.status(statusCode).json({ error: error.message });
    }
  });

  app.get("/api/documents/vouchers", async (req, res) => {
    try {
      const period = req.query.period || undefined;
      const search = String(req.query.search || "").trim().toLowerCase();
      const page = req.query.page ? Number(req.query.page) : 1;
      const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 12;

      const result = await fetchDocumentsVoucherPage({
        date: req.query.date || undefined,
        period,
        search,
        page,
        pageSize,
      });

      res.json(result);
    } catch (error) {
      console.error("[API] ERROR /api/documents/vouchers", {
        message: error.message,
        stack: error.stack,
        query: req.query,
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/documents/vouchers/download", async (req, res) => {
    try {
      const { url, filename } = req.body || {};
      if (!url) {
        return res.status(400).json({ error: "url es requerido" });
      }

      const { buffer, contentType, sourceUrl } = await fetchVoucherBinary(url);
      const resolvedFilename = sanitizeFilenamePart(
        filename || `voucher_${Date.now()}`,
        "voucher"
      );

      res.setHeader("Content-Type", contentType || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${resolvedFilename}"`);
      res.setHeader("X-Voucher-Source-Url", sourceUrl);
      res.send(buffer);
    } catch (error) {
      console.error("[API] ERROR /api/documents/vouchers/download", {
        message: error.message,
        stack: error.stack,
        body: redactSensitiveBody(req.body),
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/documents/vouchers/export-job", async (req, res) => {
    try {
      const authContext = await getAuthenticatedUserFromRequest(req).catch(() => null);
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids
        : String(req.body?.ids || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);

      const filters = {
        ids,
        exportMode: req.body?.exportMode || null,
        specificDate: req.body?.specificDate || null,
        filterPeriod: req.body?.filterPeriod || req.body?.period || "all",
        selectedMonth: req.body?.selectedMonth || null,
        searchTerm: req.body?.searchTerm || "",
        filterStatus: req.body?.filterStatus || "all",
        zipSizeBytes: null,
        zipFilename: "vouchers_depositos.zip",
        createdBy: authContext?.authUser?.id || null,
      };

      const hasDirectIds = Array.isArray(ids) && ids.length > 0;
      const hasFilters =
        Boolean(filters.specificDate) ||
        Boolean(filters.filterPeriod && filters.filterPeriod !== "all") ||
        Boolean(filters.searchTerm?.trim()) ||
        Boolean(filters.filterStatus && filters.filterStatus !== "all");

      if (!hasDirectIds && !hasFilters) {
        return res.status(400).json({ error: "Debes enviar ids o filtros de exportaciÃ³n" });
      }

      const queuedJob = await queueVoucherExportJob(filters, authContext?.authUser?.id || null);

      res.json({
        data: {
          jobId: queuedJob.id,
          status: queuedJob.status,
          progress: queuedJob.progress,
          total: queuedJob.total,
        },
      });
    } catch (error) {
      console.error("[API] ERROR /api/documents/vouchers/export-job", {
        message: error.message,
        stack: error.stack,
        body: redactSensitiveBody(req.body),
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/documents/vouchers/export-filtered", async (req, res) => {
    try {
      const authContext = await getAuthenticatedUserFromRequest(req).catch(() => null);
      const filters = {
        ids: Array.isArray(req.body?.ids) ? req.body.ids : [],
        exportMode: req.body?.exportMode || null,
        specificDate: req.body?.specificDate || null,
        filterPeriod: req.body?.filterPeriod || req.body?.period || "all",
        selectedMonth: req.body?.selectedMonth || null,
        searchTerm: req.body?.searchTerm || "",
        filterStatus: req.body?.filterStatus || "all",
      };

      const hasDirectIds = Array.isArray(filters.ids) && filters.ids.length > 0;
      const hasFilters =
        Boolean(filters.specificDate) ||
        Boolean(filters.filterPeriod && filters.filterPeriod !== "all") ||
        Boolean(filters.searchTerm?.trim()) ||
        Boolean(filters.filterStatus && filters.filterStatus !== "all");

      if (!hasDirectIds && !hasFilters) {
        return res.status(400).json({ error: "Debes enviar ids o filtros de exportaciÃ³n" });
      }

      const queuedJob = await queueVoucherExportJob(filters, authContext?.authUser?.id || null);
      res.status(202).json({
        data: {
          jobId: queuedJob.id,
          status: queuedJob.status,
          progress: queuedJob.progress,
          total: queuedJob.total,
        },
      });
    } catch (error) {
      console.error("[API] ERROR /api/documents/vouchers/export-filtered", {
        message: error.message,
        stack: error.stack,
        body: redactSensitiveBody(req.body),
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/documents/vouchers/export-jobs", async (req, res) => {
    try {
      const limit = req.query.limit ? Math.max(1, Number(req.query.limit)) : 25;
      const jobs = await fetchVoucherExportJobRows(limit);

      res.json({ data: jobs });
    } catch (error) {
      console.error("[API] ERROR /api/documents/vouchers/export-jobs", {
        message: error.message,
        stack: error.stack,
      });
      res.json({ data: Array.from(voucherExportJobs.values()).map(createVoucherExportJobSnapshot) });
    }
  });

  app.get("/api/documents/vouchers/export-job/:jobId", async (req, res) => {
    try {
      const job = await fetchVoucherExportJobRow(req.params.jobId).catch(() => null);
      if (!job) {
        return res.status(404).json({ error: "Job no encontrado" });
      }

      res.json({ data: createVoucherExportJobSnapshot(job) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/documents/vouchers/export-job/:jobId/download", async (req, res) => {
    try {
      const job = await fetchVoucherExportJobRow(req.params.jobId).catch(() => null);
      if (!job) {
        return res.status(404).json({ error: "Job no encontrado" });
      }

      if (job.status !== "completed" || !job.zipBuffer) {
        return res.status(409).json({
          error: "El ZIP todavÃ­a no estÃ¡ listo",
          status: job.status,
          progress: job.progress,
        });
      }

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="vouchers_depositos.zip"');
      const zipBuffer = job.zipBuffer || null;

      if (!zipBuffer || zipBuffer.length === 0) {
        return res.status(404).json({ error: "El ZIP no esta disponible" });
      }

      res.send(zipBuffer);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/documents/vouchers/export", async (req, res) => {
    try {
      const authContext = await getAuthenticatedUserFromRequest(req).catch(() => null);
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids
        : String(req.body?.ids || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);

      if (ids.length === 0) {
        return res.status(400).json({ error: "ids es requerido" });
      }

      const queuedJob = await queueVoucherExportJob({ ids }, authContext?.authUser?.id || null);

      res.status(202).json({
        data: {
          jobId: queuedJob.id,
          status: queuedJob.status,
          progress: queuedJob.progress,
          total: queuedJob.total,
        },
      });
    } catch (error) {
      console.error("[API] ERROR /api/documents/vouchers/export", {
        message: error.message,
        stack: error.stack,
        body: redactSensitiveBody(req.body),
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/depositos", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const body = req.body || {};
      const {
        imagen_recortada_data_url,
        imagen_recortada_name,
        ...depositPayload
      } = body;

      if (imagen_recortada_data_url) {
        const uploadedImage = await uploadDepositCroppedImageToStorage(client, imagen_recortada_data_url, {
          depositId: depositPayload?.id || "",
          numeroOperacion: depositPayload?.numero_operacion_banco || depositPayload?.numero_operacion || "",
          fileName: imagen_recortada_name || "imagen_recortada",
        });

        if (uploadedImage?.publicUrl) {
          depositPayload.imagen_voucher = uploadedImage.publicUrl;
        }
      }

      const { data, error } = await runLoggedQuery(
        "depositos.create",
        { keys: Object.keys(depositPayload || {}) },
        () =>
          client
            .from("depositos")
            .insert(depositPayload || {})
            .select(
              `id, numero_operacion, cliente, monto, fecha_registro, fecha_solo_date, imagen_voucher, anexo, numero_operacion_banco, fecha_deposito, estado, observaciones, motivo_rechazo, fecha_validacion, referencia_cliente, validado_por, moneda, ruc_cliente, telefono_origen, chatwoot_message_id, es_antiguo,
   empresa:empresa_id (id, nombre, estado, abreviatura),
   banco:banco_id (id, abreviatura, estado),
  sucursal:sucursal_id (id, nombre),
  trabajador:trabajador_sucursal_id (id, nombre, telefono_origen),
  validado_por_usuario:validado_por (id, nombre)`
            )
            .single()
      );
      if (error) throw error;
      broadcastDepositChange("INSERT", data, null, {
        source: "api/depositos",
      });
      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/ai/extract-voucher", async (req, res) => {
    try {
      const { imageDataUrl } = req.body || {};
      if (!imageDataUrl) {
        return res.status(400).json({ error: "imageDataUrl es requerido" });
      }

      const extracted = await extractVoucherDataWithOpenAI(imageDataUrl);
      res.json({ data: extracted });
    } catch (error) {
      console.error("[API] ERROR /api/ai/extract-voucher", {
        message: error.message,
      });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/reportes/summary", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const selectedTrendPeriod = req.query.trendPeriod || "semana";
      const [summaryRes, sucursalRes, bancoRes, trendsRes, crUSDRes, crPENRes, topSucursalesRes, rejectedRes] =
        await Promise.all([
          client.rpc("get_deposits_summary_by_currency", { p_moneda: null }),
          client.rpc("get_confirmed_deposits_by_sucursal_currency", { p_moneda: null }),
          client.rpc("get_confirmed_deposits_by_banco_currency", { p_moneda: null }),
          client.rpc("get_daily_deposit_trends_currency", { p_moneda: null }),
          client.rpc("get_daily_confirmed_rejected_by_currency", {
            p_moneda: "USD",
            p_periodo: selectedTrendPeriod,
          }),
          client.rpc("get_daily_confirmed_rejected_by_currency", {
            p_moneda: "PEN",
            p_periodo: selectedTrendPeriod,
          }),
          client.rpc("get_top_sucursales_by_confirmations", { p_limit: 10 }),
          client.rpc("get_rejected_deposits_by_sucursal", { p_limit: 10 }),
        ]);

      const errors = [
        summaryRes.error,
        sucursalRes.error,
        bancoRes.error,
        trendsRes.error,
        crUSDRes.error,
        crPENRes.error,
        topSucursalesRes.error,
        rejectedRes.error,
      ].filter(Boolean);

      if (errors.length > 0) {
        throw errors[0];
      }

      const translateDayToSpanish = (dayText) => {
        const translations = {
          Mon: "Lun",
          Tue: "Mar",
          Wed: "MiÃ©",
          Thu: "Jue",
          Fri: "Vie",
          Sat: "SÃ¡b",
          Sun: "Dom",
          January: "Enero",
          February: "Febrero",
          March: "Marzo",
          April: "Abril",
          May: "Mayo",
          June: "Junio",
          July: "Julio",
          August: "Agosto",
          September: "Septiembre",
          October: "Octubre",
          November: "Noviembre",
          December: "Diciembre",
          Jan: "Ene",
          Feb: "Feb",
          Mar: "Mar",
          Apr: "Abr",
          Jun: "Jun",
          Jul: "Jul",
          Aug: "Ago",
          Sep: "Sep",
          Oct: "Oct",
          Nov: "Nov",
          Dec: "Dic",
        };

        let translated = dayText;
        Object.keys(translations).forEach((eng) => {
          translated = translated.replace(eng, translations[eng]);
        });
        return translated;
      };

      const groupByName = (data) => {
        const grouped = {};
        data.forEach((item) => {
          if (!grouped[item.nombre]) {
            grouped[item.nombre] = {
              nombre: item.nombre,
              usd: { monto: 0, cantidad: 0, porcentaje: 0 },
              pen: { monto: 0, cantidad: 0, porcentaje: 0 },
            };
          }
          if (item.moneda === "USD") grouped[item.nombre].usd = { monto: item.monto, cantidad: item.cantidad, porcentaje: item.porcentaje };
          if (item.moneda === "PEN") grouped[item.nombre].pen = { monto: item.monto, cantidad: item.cantidad, porcentaje: item.porcentaje };
        });
        return Object.values(grouped);
      };

      res.json({
        summary: summaryRes.data || [],
        bySucursal: groupByName(sucursalRes.data || []),
        byBanco: groupByName(bancoRes.data || []),
        trends: trendsRes.data || [],
        confirmedRejectedUSD: (crUSDRes.data || []).map((item) => ({ ...item, dia: translateDayToSpanish(item.dia) })),
        confirmedRejectedPEN: (crPENRes.data || []).map((item) => ({ ...item, dia: translateDayToSpanish(item.dia) })),
        topSucursales: topSucursalesRes.data || [],
        rejectedBySucursal: rejectedRes.data || [],
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/bancos", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from("bancos")
        .insert([{ ...req.body, estado: "activo" }])
        .select()
        .single();
      if (error) throw error;
      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/bancos/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from("bancos")
        .update(req.body)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) throw error;
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/bancos/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { error } = await client.from("bancos").delete().eq("id", req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/empresas", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from("empresas")
        .insert({ ...req.body, estado: "activo" })
        .select()
        .single();
      if (error) throw error;
      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/empresas/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from("empresas")
        .update(req.body)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) throw error;
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/cuentas-bancarias", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from("cuentas_bancarias")
        .insert(req.body)
        .select("*, empresa:empresas(*), banco:bancos(*)")
        .single();
      if (error) throw error;
      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/cuentas-bancarias/bulk", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const { data, error } = await client
        .from("cuentas_bancarias")
        .insert(rows)
        .select("*, empresa:empresas(*), banco:bancos(*)");
      if (error) throw error;
      res.status(201).json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/cuentas-bancarias/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from("cuentas_bancarias")
        .update(req.body)
        .eq("id", req.params.id)
        .select("*, empresa:empresas(*), banco:bancos(*)")
        .single();
      if (error) throw error;
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/cuentas-bancarias/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { error } = await client.from("cuentas_bancarias").delete().eq("id", req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/sucursales", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from("sucursales").insert(req.body).select().single();
      if (error) throw error;
      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/sucursales/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from("sucursales")
        .update(req.body)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) throw error;
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/personal", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client.from("sucursal_personal").insert(req.body).select().single();
      if (error) throw error;
      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/personal/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await client
        .from("sucursal_personal")
        .update(req.body)
        .eq("id", req.params.id)
        .select()
        .single();
      if (error) throw error;
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/personal/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { error } = await client.from("sucursal_personal").delete().eq("id", req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/sucursales/import-workers", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

      if (rows.length === 0) {
        return res.status(400).json({ error: "rows es requerido" });
      }

      const sucursalesMap = new Map();
      for (const row of rows) {
        const key = String(row?.sucursal || "").trim();
        if (!key) continue;
        if (!sucursalesMap.has(key)) {
          sucursalesMap.set(key, []);
        }
        sucursalesMap.get(key).push(row);
      }

      let successCount = 0;
      let errorCount = 0;

      for (const [sucursalNombre, workers] of sucursalesMap.entries()) {
        const existingSucursalRes = await runLoggedQuery(
          "sucursales.import.searchSucursal",
          { sucursalNombre },
          () => client.from("sucursales").select("id").eq("nombre", sucursalNombre).maybeSingle()
        );

        if (existingSucursalRes.error) {
          errorCount += workers.length;
          continue;
        }

        let sucursalId = existingSucursalRes.data?.id || null;
        if (!sucursalId) {
          const createSucursalRes = await runLoggedQuery(
            "sucursales.import.createSucursal",
            { sucursalNombre },
            () =>
              client
                .from("sucursales")
                .insert({ nombre: sucursalNombre, estado: "activa" })
                .select("*")
                .single()
          );

          if (createSucursalRes.error) {
            errorCount += workers.length;
            continue;
          }

          sucursalId = createSucursalRes.data?.id || null;
        }

        for (const worker of workers) {
          try {
            const tipo = String(worker?.tipo || "").toUpperCase();
            const nombre = String(worker?.nombreTrabajador || "").trim();
            const telefono = String(worker?.telefono || "").trim();
            const empresa = String(worker?.empresa || "").trim() || null;

            if (!nombre || !telefono) {
              errorCount++;
              continue;
            }

            if (tipo === "ELIMINAR") {
              const existingWorkerRes = await runLoggedQuery(
                "sucursales.import.searchWorkerDelete",
                { nombre, telefono },
                () =>
                  client
                    .from("sucursal_personal")
                    .select("id")
                    .eq("nombre", nombre)
                    .eq("telefono_origen", telefono)
                    .maybeSingle()
              );

              if (existingWorkerRes.error || !existingWorkerRes.data) {
                errorCount++;
                continue;
              }

              const deactivateRes = await runLoggedQuery(
                "sucursales.import.deactivateWorker",
                { id: existingWorkerRes.data.id },
                () =>
                  client
                    .from("sucursal_personal")
                    .update({ estado: "inactivo" })
                    .eq("id", existingWorkerRes.data.id)
              );

              if (deactivateRes.error) {
                errorCount++;
              } else {
                successCount++;
              }
              continue;
            }

            const existingByPhoneRes = await runLoggedQuery(
              "sucursales.import.searchByPhone",
              { telefono },
              () =>
                client
                  .from("sucursal_personal")
                  .select("id, estado, sucursal_id, nombre")
                  .eq("telefono_origen", telefono)
                  .maybeSingle()
            );

            if (existingByPhoneRes.error) {
              errorCount++;
              continue;
            }

            if (
              existingByPhoneRes.data &&
              String(existingByPhoneRes.data.sucursal_id) !== String(sucursalId)
            ) {
              errorCount++;
              continue;
            }

            const existingWorkerRes = await runLoggedQuery(
              "sucursales.import.searchWorker",
              { nombre, telefono },
              () =>
                client
                  .from("sucursal_personal")
                  .select("id, estado")
                  .eq("nombre", nombre)
                  .eq("telefono_origen", telefono)
                  .maybeSingle()
            );

            if (existingWorkerRes.error) {
              errorCount++;
              continue;
            }

            if (existingWorkerRes.data) {
              if (existingWorkerRes.data.estado === "inactivo") {
                const reactivateRes = await runLoggedQuery(
                  "sucursales.import.reactivateWorker",
                  { id: existingWorkerRes.data.id },
                  () =>
                    client
                      .from("sucursal_personal")
                      .update({ estado: "activo" })
                      .eq("id", existingWorkerRes.data.id)
                );

                if (reactivateRes.error) {
                  errorCount++;
                } else {
                  successCount++;
                }
              } else {
                errorCount++;
              }
              continue;
            }

            const insertRes = await runLoggedQuery(
              "sucursales.import.insertWorker",
              { sucursalId, nombre, telefono },
              () =>
                client
                  .from("sucursal_personal")
                  .insert({
                    sucursal_id: sucursalId,
                    nombre,
                    telefono_origen: telefono,
                    empresa,
                    estado: "activo",
                    tipo_registro: "importado",
                  })
                  .select("*")
                  .single()
            );

            if (insertRes.error) {
              errorCount++;
            } else {
              successCount++;
            }
          } catch {
            errorCount++;
          }
        }
      }

      res.json({ ok: true, successCount, errorCount });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/depositos/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { id, empresa, banco, sucursal, trabajador, validado_por_usuario, ...updateData } = req.body || {};
      const targetId = req.params.id || id;
      const { data, error } = await runLoggedQuery(
        "depositos.update",
        { id: targetId, updateKeys: Object.keys(updateData) },
        () =>
          client
            .from("depositos")
            .update(updateData)
            .eq("id", targetId)
            .select(
                `id, numero_operacion, cliente, monto, fecha_registro, fecha_solo_date, imagen_voucher, anexo, numero_operacion_banco, fecha_deposito, estado, observaciones, motivo_rechazo, fecha_validacion, referencia_cliente, validado_por, moneda, ruc_cliente, telefono_origen, chatwoot_message_id, es_antiguo,
  empresa:empresa_id (id, nombre, estado, abreviatura),
  banco:banco_id (id, abreviatura, estado),
  sucursal:sucursal_id (id, nombre),
  trabajador:trabajador_sucursal_id (id, nombre, telefono_origen),
  validado_por_usuario:validado_por (id, nombre)`
            )
            .single()
      );
      if (error) throw error;
      broadcastDepositChange("UPDATE", data, null, {
        source: "api/depositos/:id",
        id: targetId,
      });
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/depositos/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const existing = await runLoggedQuery(
        "depositos.delete.fetchBeforeDelete",
        { id: req.params.id },
        () => client.from("depositos").select("*").eq("id", req.params.id).maybeSingle()
      );
      if (existing.error) throw existing.error;
      const { error } = await runLoggedQuery(
        "depositos.delete",
        { id: req.params.id },
        () => client.from("depositos").delete().eq("id", req.params.id)
      );
      if (error) throw error;
      broadcastDepositChange("DELETE", null, existing.data || null, {
        source: "api/depositos/:id",
        id: req.params.id,
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/drive-files/unlinked", async (_req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await runLoggedQuery(
        "driveFiles.unlinked",
        {},
        () =>
          client
            .from("drive_files")
            .select("*")
            .is("deposito_id", null)
            .order("id", { ascending: false })
      );
      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/drive-files/deposit/:depositoId", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await runLoggedQuery(
        "driveFiles.byDeposit",
        { depositoId: req.params.depositoId },
        () =>
          client
            .from("drive_files")
            .select("*")
            .eq("deposito_id", req.params.depositoId)
            .order("id", { ascending: false })
      );
      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/drive-files/search", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const term = String(req.query.term || "").trim();
      if (!term) {
        return res.json({ data: [] });
      }

      const { data, error } = await runLoggedQuery(
        "driveFiles.search",
        { term },
        () =>
          client
            .from("drive_files")
            .select("*")
            .or(`file_url.ilike.%${term}%,deposito_id.eq.${term}`)
            .order("id", { ascending: false })
      );
      if (error) throw error;
      res.json({ data: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/drive-files", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const payload = {
        file_url: req.body?.file_url,
        deposito_id: req.body?.deposito_id || null,
      };
      if (!payload.file_url) {
        return res.status(400).json({ error: "file_url es requerido" });
      }

      const { data, error } = await runLoggedQuery(
        "driveFiles.insert",
        payload,
        () => client.from("drive_files").insert([payload]).select().single()
      );
      if (error) throw error;
      res.status(201).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/drive-files/:id/link", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const fileId = req.params.id;
      const depositoId = req.body?.deposito_id;
      if (!depositoId) {
        return res.status(400).json({ error: "deposito_id es requerido" });
      }

      const fileQuery = await runLoggedQuery(
        "driveFiles.link.fetch",
        { fileId, depositoId },
        () => client.from("drive_files").select("file_url").eq("id", fileId).single()
      );
      if (fileQuery.error) throw fileQuery.error;

      const { data: updatedFile, error: linkError } = await runLoggedQuery(
        "driveFiles.link.updateFile",
        { fileId, depositoId },
        () =>
          client
            .from("drive_files")
            .update({ deposito_id: depositoId })
            .eq("id", fileId)
            .select()
            .single()
      );
      if (linkError) throw linkError;

      const { data: updatedDeposit, error: depositError } = await runLoggedQuery(
        "driveFiles.link.updateDeposit",
        { fileId, depositoId },
        () =>
          client
            .from("depositos")
            .update({ imagen_voucher: fileQuery.data.file_url })
            .eq("id", depositoId)
            .select("id, imagen_voucher")
            .single()
      );
      if (depositError) {
        await client
          .from("drive_files")
          .update({ deposito_id: null })
          .eq("id", fileId);
        throw depositError;
      }

      broadcastDepositChange("UPDATE", updatedDeposit, null, {
        source: "api/drive-files/:id/link",
        fileId,
        depositoId,
      });

      res.json({ data: { file: updatedFile, deposito: updatedDeposit } });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/drive-files/:id/unlink", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { data, error } = await runLoggedQuery(
        "driveFiles.unlink",
        { id: req.params.id },
        () =>
          client
            .from("drive_files")
            .update({ deposito_id: null })
            .eq("id", req.params.id)
            .select()
            .single()
      );
      if (error) throw error;
      if (data?.deposito_id) {
        const refreshedDeposit = await runLoggedQuery(
          "driveFiles.unlink.refreshDeposit",
          { fileId: req.params.id, depositoId: data.deposito_id },
          () =>
            client
              .from("depositos")
              .select(
                `id, numero_operacion, cliente, monto, fecha_registro, fecha_solo_date, imagen_voucher, anexo, numero_operacion_banco, fecha_deposito, estado, observaciones, motivo_rechazo, fecha_validacion, referencia_cliente, validado_por, moneda, ruc_cliente, telefono_origen, chatwoot_message_id, es_antiguo,
  empresa:empresa_id (id, nombre, estado, abreviatura),
  banco:banco_id (id, abreviatura, estado),
  sucursal:sucursal_id (id, nombre),
  trabajador:trabajador_sucursal_id (id, nombre, telefono_origen),
  validado_por_usuario:validado_por (id, nombre)`
              )
              .eq("id", data.deposito_id)
              .single()
        );

        if (!refreshedDeposit.error) {
          broadcastDepositChange("UPDATE", refreshedDeposit.data || null, null, {
            source: "api/drive-files/:id/unlink",
            fileId: req.params.id,
            depositoId: data.deposito_id,
          });
        }
      }
      res.json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/drive-files/:id", async (req, res) => {
    try {
      const client = getSupabaseAdminClient();
      const { error } = await runLoggedQuery(
        "driveFiles.delete",
        { id: req.params.id },
        () => client.from("drive_files").delete().eq("id", req.params.id)
      );
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

function broadcast(event) {
  broadcastSseEvent("deposit-change", event);
}

function broadcastSseEvent(eventName, event) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function broadcastDepositChange(eventType, row, oldRow = null, meta = {}) {
  const event = {
    type: "deposit-change",
    eventType,
    new: row || null,
    old: oldRow || null,
    meta,
    timestamp: new Date().toISOString(),
  };

  console.log("[SSE] deposit-change", {
    eventType,
    id: row?.id || oldRow?.id || null,
    clients: clients.size,
  });

  broadcastSseEvent("deposit-change", event);
}

function broadcastSupportRequestChange(eventType, row, oldRow = null, meta = {}) {
  if (!shouldBroadcastSupportRequestEvent(eventType, row, oldRow)) {
    return;
  }

  const event = {
    type: "support-request",
    eventType,
    new: row || null,
    old: oldRow || null,
    meta,
    timestamp: new Date().toISOString(),
  };

  console.log("[SSE] support-request", {
    eventType,
    id: row?.id || oldRow?.id || null,
    clients: clients.size,
  });

  broadcastSseEvent("support-request", event);
}

async function updateSupportRequestAsAcknowledged(client, requestId, acknowledgedBy, options = {}) {
  const nowIso = new Date().toISOString();
  const updates = {
    status: "atendido",
    acknowledged_by: acknowledgedBy,
    acknowledged_at: nowIso,
    resolved_by: acknowledgedBy,
    resolved_at: nowIso,
    notes: options.notes || "Reconocido desde la app de bandeja",
    updated_at: nowIso,
  };

  const existingRecordResult = await runLoggedQuery(
    "support_requests.findById",
    { requestId },
    () => client.from("support_requests").select("*").eq("id", requestId).maybeSingle()
  );

  if (existingRecordResult.error) throw existingRecordResult.error;
  if (!existingRecordResult.data) {
    return { statusCode: 404, error: "support_request no encontrada" };
  }

  const { data, error } = await runLoggedQuery(
    "support_requests.update",
    { requestId, updates },
    () => client.from("support_requests").update(updates).eq("id", requestId).select("*").single()
  );

  if (error) throw error;

  return { statusCode: 200, data, oldData: existingRecordResult.data };
}

async function updateSupportRequestAsExpired(client, requestId, options = {}) {
  const nowIso = new Date().toISOString();
  const updates = {
    status: "vencida",
    resolved_at: nowIso,
    resolved_by: options.resolvedBy || "system",
    notes: options.notes || "Vencido por expiración en la app de bandeja",
    updated_at: nowIso,
  };

  const existingRecordResult = await runLoggedQuery(
    "support_requests.findById",
    { requestId },
    () => client.from("support_requests").select("*").eq("id", requestId).maybeSingle()
  );

  if (existingRecordResult.error) throw existingRecordResult.error;
  if (!existingRecordResult.data) {
    return { statusCode: 404, error: "support_request no encontrada" };
  }

  const { data, error } = await runLoggedQuery(
    "support_requests.update",
    { requestId, updates },
    () => client.from("support_requests").update(updates).eq("id", requestId).select("*").single()
  );

  if (error) throw error;

  return { statusCode: 200, data, oldData: existingRecordResult.data };
}

function summarizeRealtimeError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name || "Error";
  if (typeof error === "object") {
    return error.message || error.reason || error.code || error.status || "realtime error";
  }
  return String(error);
}

function setRealtimeStatus(status, error = null) {
  if (realtimeStatus === status && !["READY", "STARTING", "RESTARTING"].includes(status)) {
    return;
  }

  realtimeStatus = status;
  if (status === "READY") {
    console.log("Backend realtime worker listo para depositos");
  } else if (status === "STARTING") {
    console.log("Backend realtime worker iniciando");
  } else if (status === "RESTARTING") {
    console.warn("Backend realtime worker reiniciando");
  } else if (status === "CHANNEL_ERROR") {
    console.error("Backend realtime error:", summarizeRealtimeError(error));
  } else if (status === "TIMED_OUT") {
    console.warn("Backend realtime timeout:", summarizeRealtimeError(error));
  } else if (status === "CLOSED") {
    console.warn("Backend realtime canal cerrado");
  } else if (status === "ERROR") {
    console.error("Backend realtime worker error:", summarizeRealtimeError(error));
  } else if (status === "DISABLED") {
    console.warn("Backend realtime desactivado:", summarizeRealtimeError(error));
  } else if (status === "DISCONNECTED") {
    console.warn("Backend realtime worker desconectado");
  }
}

function getRealtimeWorkerPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "realtimeWorker.js");
}

function scheduleRealtimeWorkerRestart() {
  if (realtimeWorkerRestartTimeout) {
    return;
  }

  setRealtimeStatus("RESTARTING");
  realtimeWorkerRestartTimeout = setTimeout(() => {
    realtimeWorkerRestartTimeout = null;
    startDepositRealtimeHub();
  }, 5000);
}

function handleRealtimeWorkerMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "status") {
    setRealtimeStatus(message.status, message.error || null);
    return;
  }

  if (message.type === "deposit-change") {
    if (String(message.eventType || "").trim().toUpperCase() === "INSERT") {
      const client = getSupabaseAdminClient();
      if (client) {
        void (async () => {
          try {
            const deposit = message.new || null;
            await processAutomaticSupportAlertCandidate(client, deposit, {
              trigger: "realtime-worker",
            });
            advanceAutomaticSupportAlertCursor(getDepositCreatedAtIso(deposit) || new Date().toISOString());
          } catch (error) {
            console.warn(
              "[support-requests] automatic alert insert processing failed:",
              error?.message || error
            );
          }
        })();
      }
    }
    broadcast({
      type: "deposit-change",
      eventType: message.eventType,
      new: message.new,
      old: message.old,
      timestamp: message.timestamp || new Date().toISOString(),
    });
    return;
  }

  if (message.type === "support-request-change") {
    broadcastSupportRequestChange(
      message.eventType,
      message.new || null,
      message.old || null,
      {
        source: message.source || "realtime-worker",
      }
    );
  }
}

export function startDepositRealtimeHub() {
  loadLocalEnv();

  if (realtimeWorker?.connected) {
    return true;
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.warn(
      "Backend realtime desactivado: faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY"
    );
    realtimeStatus = "DISABLED";
    return false;
  }

  realtimeStatus = "STARTING";
  startAutomaticSupportAlertMonitor();
  const realtimeWorkerPath = getRealtimeWorkerPath();
  const worker = fork(realtimeWorkerPath, [], {
    env: {
      ...process.env,
      REALTIME_WORKER: "1",
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });

  realtimeWorker = worker;
  console.log("Backend realtime worker spawned", { pid: worker.pid });
  realtimeWorker.on("message", handleRealtimeWorkerMessage);
  realtimeWorker.on("error", (error) => {
    console.error("Backend realtime worker error:", summarizeRealtimeError(error));
    setRealtimeStatus("ERROR", error);
  });
  realtimeWorker.on("exit", (code, signal) => {
    if (realtimeWorker === worker) {
      realtimeWorker = null;
    }
    console.warn("Backend realtime worker exited", { code, signal });
    setRealtimeStatus("DISCONNECTED", { code, signal });
    scheduleRealtimeWorkerRestart();
  });
  realtimeWorker.on("disconnect", () => {
    if (realtimeWorker === worker) {
      realtimeWorker = null;
    }
    console.warn("Backend realtime worker disconnected");
    setRealtimeStatus("DISCONNECTED");
    scheduleRealtimeWorkerRestart();
  });

  return true;
}

export function registerDepositSseRoute(app) {
  const handleSseConnection = (req, res) => {
    const allowedOrigin = getAllowedOrigin(req);

    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cache-Control");
    res.setHeader("Vary", "Origin");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders?.();

    console.log("[SSE] cliente conectado", {
      clients: clients.size + 1,
      realtimeStatus,
    });

    res.write(
      `event: connected\ndata: ${JSON.stringify({
        ok: true,
        timestamp: new Date().toISOString(),
      })}\n\n`
    );

    clients.add(res);

    const keepAlive = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(res);
      console.log("[SSE] cliente desconectado", {
        clients: clients.size,
        realtimeStatus,
      });
    });
  };

  app.get("/api/events/depositos", handleSseConnection);
  app.get("/api/events/support-requests", handleSseConnection);

  app.options("/api/events/depositos", (req, res) => {
    const allowedOrigin = getAllowedOrigin(req);

    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cache-Control");
    res.setHeader("Vary", "Origin");
    res.sendStatus(204);
  });

  app.options("/api/events/support-requests", (req, res) => {
    const allowedOrigin = getAllowedOrigin(req);

    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cache-Control");
    res.setHeader("Vary", "Origin");
    res.sendStatus(204);
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      clients: clients.size,
      realtime: !!realtimeWorker,
      realtimeStatus,
      buildSha: process.env.GIT_SHA || "local",
    });
  });
}

export function registerDashboardApiRoutes(app) {
  registerNoCacheHeaders(app);
  registerJsonRoutes(app);
}

export { registerRequestLogger, runVoucherExportJob };
