import crypto from "node:crypto";
import fs from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import sharp from "sharp";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { ApplicationStatus } from "@ica/contracts";
import { AppError } from "./errors.js";
import { getWebDistDir } from "./paths.js";
import { SettingsService } from "./application/settings-service.js";
import { ScannerService } from "./application/scanner-service.js";
import { ImageService } from "./application/image-service.js";
import { JobService } from "./application/job-service.js";
import { ApplicationLifecycle } from "./application/application-lifecycle.js";

export interface AppServices {
  db: Database.Database;
  settings: SettingsService;
  scanner: ScannerService;
  images: ImageService;
  jobs: JobService;
}

const updateSettingsSchema = z.object({
  sourceDir: z.string().min(1),
  outputDir: z.string().min(1),
  recursive: z.boolean(),
  compressionConcurrency: z.number().int().min(1).max(5),
  createOutputDir: z.boolean(),
  apiKeyAction: z.enum(["keep", "replace"]),
  apiKey: z.string().nullable().optional()
});

const imageStatuses = ["pending", "queued", "compressing", "compressed", "source_changed", "output_missing", "failed", "unsupported"] as const;

export async function buildApp(
  services: AppServices,
  options: { production?: boolean; lifecycle?: ApplicationLifecycle } = {}
) {
  const token = crypto.randomBytes(32).toString("base64url");
  const eventClients = new Set<NodeJS.WritableStream>();
  const publish = (type: string, entityId?: string) => {
    const payload = `data: ${JSON.stringify({ type, entityId: entityId ?? null, occurredAt: new Date().toISOString() })}\n\n`;
    for (const client of eventClients) client.write(payload);
  };
  services.jobs.setOnChange((jobId) => publish("job.changed", jobId));
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: [
        "req.headers.authorization",
        "req.headers.x-local-app-token",
        "req.body.apiKey",
        "req.body.candidateKey"
      ]
    },
    bodyLimit: 1024 * 1024
  });

  app.addHook("onRequest", async (request, reply) => {
    const hostname = request.hostname.replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      throw new AppError("INVALID_HOST", "请求主机不受信任", 403);
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      if (request.headers["x-local-app-token"] !== token) throw new AppError("INVALID_LOCAL_TOKEN", "本地会话已过期，请刷新页面", 403);
      const origin = request.headers.origin;
      if (origin) {
        const parsed = new URL(origin);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
          throw new AppError("INVALID_ORIGIN", "请求来源不受信任", 403);
        }
      }
      if (options.lifecycle?.getStatus().shuttingDown && request.url !== "/api/application/shutdown") {
        throw new AppError("APP_SHUTTING_DOWN", "应用正在退出，不能执行此操作", 503);
      }
    }
  });

  app.addHook("preClose", async () => {
    for (const client of eventClients) client.end();
    eventClients.clear();
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details }, meta: { requestId } });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "请求内容无效", details: error.issues }, meta: { requestId } });
    }
    request.log.error(error);
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "本地服务发生错误" }, meta: { requestId } });
  });

  const ok = <T>(request: any, data: T) => ({ data, meta: { requestId: request.id } });

  app.get("/api/health", async (request) => ok(request, {
    status: "ok",
    application: "image-compression-automation",
    shuttingDown: options.lifecycle?.getStatus().shuttingDown ?? false
  }));
  app.get("/api/session", async (request) => ok(request, { token }));
  app.get("/api/application/status", async (request) => {
    const status: ApplicationStatus = options.lifecycle?.getStatus() ?? {
      shuttingDown: false,
      activeJobs: services.jobs.getActiveCounts()
    };
    return ok(request, status);
  });
  app.post("/api/application/shutdown", async (request) => {
    if (!options.lifecycle) throw new AppError("SHUTDOWN_UNAVAILABLE", "当前运行模式不支持从页面退出", 503);
    const body = z.object({ confirmActiveJobs: z.boolean().default(false) }).parse(request.body ?? {});
    options.lifecycle.requestShutdown(body.confirmActiveJobs);
    return ok(request, { accepted: true });
  });
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(`data: ${JSON.stringify({ type: "connected", occurredAt: new Date().toISOString() })}\n\n`);
    eventClients.add(reply.raw);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      eventClients.delete(reply.raw);
    });
  });
  app.get("/api/settings", async (request) => ok(request, await services.settings.getResponse()));
  app.put("/api/settings", async (request) => {
    const body = updateSettingsSchema.parse(request.body);
    const result = await services.settings.update({
      sourceDir: body.sourceDir,
      outputDir: body.outputDir,
      recursive: body.recursive,
      compressionConcurrency: body.compressionConcurrency,
      createOutputDir: body.createOutputDir,
      apiKeyAction: body.apiKeyAction,
      ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {})
    });
    services.scanner.start("incremental");
    publish("settings.changed");
    return ok(request, result);
  });
  app.post("/api/settings/test-tinypng", async (request) => {
    const body = z.object({ candidateKey: z.string().optional() }).parse(request.body ?? {});
    return ok(request, await services.settings.testKey(body.candidateKey));
  });
  app.delete("/api/settings/tinypng-key", async (request) => {
    await services.settings.deleteKey();
    return ok(request, { deleted: true });
  });

  app.post("/api/scans", async (request) => {
    const body = z.object({ mode: z.enum(["incremental", "force_hash"]).default("incremental") }).parse(request.body ?? {});
    const result = services.scanner.start(body.mode);
    publish("scan.changed", result.id ?? undefined);
    return ok(request, result);
  });
  app.get("/api/scans/current", async (request) => ok(request, services.scanner.getCurrent()));

  app.get("/api/images", async (request) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
      query: z.string().optional(),
      status: z.string().optional(),
      format: z.string().optional(),
      sort: z.enum(["filename", "sourceSize", "sourceMtime", "compressedAt", "savedRatio"]).default("filename"),
      order: z.enum(["asc", "desc"]).default("asc")
    }).parse(request.query);
    const statuses = query.status?.split(",").filter((item): item is (typeof imageStatuses)[number] => imageStatuses.includes(item as any));
    return ok(request, await services.images.list({
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
      ...(query.query !== undefined ? { query: query.query } : {}),
      ...(statuses !== undefined ? { statuses } : {}),
      ...(query.format !== undefined ? { formats: query.format.split(",").filter(Boolean) } : {})
    }));
  });
  app.get("/api/images/selectable", async (request) => {
    const query = z.object({
      query: z.string().optional(),
      status: z.string().optional(),
      format: z.string().optional()
    }).parse(request.query);
    const statuses = query.status?.split(",").filter((item): item is (typeof imageStatuses)[number] => imageStatuses.includes(item as any));
    const ids = await services.images.selectableIds({
      sort: "filename",
      order: "asc",
      ...(query.query !== undefined ? { query: query.query } : {}),
      ...(statuses !== undefined ? { statuses } : {}),
      ...(query.format !== undefined ? { formats: query.format.split(",").filter(Boolean) } : {})
    });
    return ok(request, { ids });
  });
  app.get("/api/images/:id/thumbnail", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { path: source, row } = await services.images.sourcePath(id);
    const etag = `"${row.source_hash}-256"`;
    if (request.headers["if-none-match"] === etag) return reply.status(304).send();
    const buffer = await sharp(source).resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    return reply.header("Content-Type", "image/webp").header("Cache-Control", "private, max-age=31536000, immutable").header("ETag", etag).send(buffer);
  });
  app.get("/api/images/:id/preview", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { variant } = z.object({ variant: z.enum(["source", "output"]).default("source") }).parse(request.query);
    const media = await services.images.previewPath(id, variant);
    return reply.header("Content-Type", media.mimeType).header("Cache-Control", "private, max-age=60").send(fs.createReadStream(media.path));
  });

  app.post("/api/jobs", async (request) => {
    const body = z.object({ clientRequestId: z.string().min(1), imageIds: z.array(z.string()).min(1).max(1000), confirmRecompress: z.boolean().default(false) }).parse(request.body);
    const result = await services.jobs.create(body.clientRequestId, body.imageIds, body.confirmRecompress);
    publish("job.changed", result.id);
    return ok(request, result);
  });
  app.get("/api/jobs", async (request) => ok(request, services.jobs.list()));
  app.get("/api/jobs/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return ok(request, services.jobs.get(id));
  });
  app.post("/api/jobs/:id/cancel", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = services.jobs.cancel(id);
    publish("job.changed", id);
    return ok(request, result);
  });
  app.post("/api/job-items/:id/retry", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = await services.jobs.retryItem(id);
    publish("job.changed", result.id);
    return ok(request, result);
  });

  if (options.production) {
    const webRoot = getWebDistDir();
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "接口不存在" }, meta: { requestId: request.id } });
      return reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'").sendFile("index.html");
    });
  }
  return app;
}
