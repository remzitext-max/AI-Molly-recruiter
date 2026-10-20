import crypto from "node:crypto";
import type { User } from "@prisma/client";
import { db } from "./db";
import { randomToken, sha256 } from "./crypto";
import { getSettings } from "./settings";
import { config } from "./config";
import { recordEvent } from "./activity";
import { advancePipeline } from "./leads";
import { getAdapters } from "../adapters/registry";
import { enqueue } from "./jobs/queue";
import { telegramConfigured } from "./telegram";
import { assertLeadAccess, ForbiddenError } from "./rbac";

export const ALLOWED_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "application/pdf": { ext: "pdf", magic: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  "image/heic": { ext: "heic", magic: (b) => b.subarray(4, 12).toString("latin1").startsWith("ftyphei") || b.subarray(4, 12).toString("latin1").startsWith("ftypmif1") },
};

export function detectMime(b: Buffer): string | null {
  for (const [mime, t] of Object.entries(ALLOWED_TYPES)) if (t.magic(b)) return mime;
  return null;
}

/** Create a short-lived, unguessable upload link. Only the hash is stored. */
export async function createUploadLink(leadId: string) {
  const s = await getSettings();
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + s.uploadLinkTtlMinutes * 60_000);
  await db.uploadToken.updateMany({ where: { leadId, completedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  await db.uploadToken.create({ data: { leadId, tokenHash: sha256(token), expiresAt } });
  return { token, url: `${config.appUrl}/u/${token}`, expiresAt };
}

export async function lookupUploadToken(token: string) {
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
  const t = await db.uploadToken.findUnique({ where: { tokenHash: sha256(token) }, include: { lead: { select: { id: true, firstName: true, optedOutAt: true, isDemo: true, org: { select: { name: true } } } } } });
  if (!t || t.revokedAt || t.completedAt || t.expiresAt < new Date() || t.filesUsed >= t.maxFiles) return null;
  return t;
}

export class UploadError extends Error { status = 400; }

export async function handleUpload(token: string, file: { data: Buffer; declaredType?: string; name?: string }) {
  const t = await lookupUploadToken(token);
  if (!t) throw new UploadError("This upload link is invalid or has expired.");
  const s = await getSettings();
  if (file.data.length === 0) throw new UploadError("The file is empty.");
  if (file.data.length > s.maxUploadBytes) throw new UploadError(`File is too large (max ${Math.round(s.maxUploadBytes / 1048576)} MB).`);
  const mime = detectMime(file.data);
  if (!mime) throw new UploadError("Only JPG, PNG, HEIC photos or PDF files are accepted.");

  // Atomically consume one file slot.
  const consumed = await db.uploadToken.updateMany({ where: { id: t.id, filesUsed: { lt: t.maxFiles }, revokedAt: null, completedAt: null }, data: { filesUsed: { increment: 1 } } });
  if (!consumed.count) throw new UploadError("This upload link has already been used.");

  const key = `cdl/${t.leadId}/${crypto.randomUUID()}.${ALLOWED_TYPES[mime].ext}`;
  await getAdapters().storage.put(key, file.data, mime);
  const doc = await db.document.create({
    data: {
      leadId: t.leadId, isDemo: t.lead.isDemo, kind: "CDL", storageKey: key, mimeType: mime, sizeBytes: file.data.length,
      sha256: sha256(file.data), deleteAfter: new Date(Date.now() + s.documentRetentionDays * 86400_000),
    },
  });
  await db.lead.update({ where: { id: t.leadId }, data: { documentStatus: "RECEIVED" } });
  await advancePipeline(t.leadId, "DOCS_RECEIVED");
  // Never log file contents or license numbers: only metadata.
  await recordEvent({ leadId: t.leadId, actorType: "DRIVER", type: "DOCUMENT_RECEIVED", message: `CDL document received (${mime}, ${Math.round(file.data.length / 1024)} KB)`, data: { documentId: doc.id } });
  if (telegramConfigured() && !t.lead.isDemo) await enqueue("notify.telegram-document", { documentId: doc.id }, { idempotencyKey: `telegram-doc:${doc.id}`, maxAttempts: 3 });

  try {
    const ex = await getAdapters().extraction.extract(file.data, mime);
    await db.document.update({ where: { id: doc.id }, data: { extraction: ex as object } });
  } catch {
    /* extraction is optional */
  }
  await enqueue("handoff.evaluate", { leadId: t.leadId }, { idempotencyKey: `handoff-eval:${doc.id}` });
  return { documentId: doc.id };
}

export async function finishUpload(token: string) {
  const t = await lookupUploadToken(token);
  if (t) await db.uploadToken.update({ where: { id: t.id }, data: { completedAt: new Date() } });
}

/** Authorized document retrieval. Every access is audited. */
export async function readDocumentForUser(user: Pick<User, "id" | "role" | "orgId">, documentId: string) {
  const doc = await db.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.deletedAt) throw new ForbiddenError("Not found");
  await assertLeadAccess(user, doc.leadId);
  const data = await getAdapters().storage.get(doc.storageKey);
  await recordEvent({ leadId: doc.leadId, actorType: "USER", actorId: user.id, type: "DOCUMENT_VIEWED", message: "CDL document viewed", data: { documentId } });
  return { doc, data };
}

export async function deleteDocument(documentId: string, actor: { type: "USER" | "SYSTEM"; id?: string | null }, reason: string) {
  const doc = await db.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.deletedAt) return;
  await getAdapters().storage.delete(doc.storageKey);
  await db.document.update({ where: { id: documentId }, data: { deletedAt: new Date(), extraction: undefined } });
  const remaining = await db.document.count({ where: { leadId: doc.leadId, deletedAt: null } });
  if (!remaining) await db.lead.update({ where: { id: doc.leadId }, data: { documentStatus: "DELETED" } });
  await recordEvent({ leadId: doc.leadId, actorType: actor.type, actorId: actor.id, type: "DOCUMENT_DELETED", message: `CDL document deleted (${reason})` });
}

export async function runRetentionSweep(now = new Date()) {
  const due = await db.document.findMany({ where: { deletedAt: null, deleteAfter: { lte: now } }, select: { id: true } });
  for (const d of due) await deleteDocument(d.id, { type: "SYSTEM" }, "retention period ended");
  await db.uploadToken.updateMany({ where: { expiresAt: { lt: now }, completedAt: null, revokedAt: null }, data: { revokedAt: now } });
  const expiredLeads = await db.lead.findMany({ where: { documentStatus: "REQUESTED", uploadTokens: { every: { OR: [{ revokedAt: { not: null } }, { expiresAt: { lt: now } }] } } }, select: { id: true } });
  for (const l of expiredLeads) await db.lead.update({ where: { id: l.id }, data: { documentStatus: "EXPIRED" } });
  return { deleted: due.length };
}
