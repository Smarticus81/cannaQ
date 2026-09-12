import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { attachmentsTable, attachmentBlobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrProvisionCurrentUser } from "../lib/currentUser";

const router: IRouter = Router();

// 50 MB cap; safelist of types accepted across the eQMS.
const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_PREFIXES = ["image/"];
const ALLOWED_EXACT = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
]);

function isAllowedContentType(ct: string): boolean {
  if (!ct) return false;
  if (ALLOWED_EXACT.has(ct)) return true;
  return ALLOWED_PREFIXES.some((p) => ct.startsWith(p));
}

const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

// POST /storage/upload — the browser uploads the file straight to us (multipart)
// and we store the bytes in Postgres (Railway). No third-party object store, no
// signed URLs, no browser-to-cloud CORS. Returns the object_path the caller then
// records on the attachment metadata row via POST /attachments.
router.post(
  "/storage/upload",
  uploadMw.single("file"),
  async (req: Request, res: Response) => {
    const user = await getOrProvisionCurrentUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required to upload files." });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file provided." });
      return;
    }
    const { originalname, mimetype, size, buffer } = req.file;
    if (!isAllowedContentType(mimetype)) {
      res.status(400).json({
        error: `File type "${mimetype || "unknown"}" is not allowed. Permitted: PDF, Word, Excel, CSV, plain text, and images.`,
      });
      return;
    }
    if (size <= 0 || size > MAX_BYTES) {
      res.status(400).json({ error: `File too large. Maximum is ${MAX_BYTES} bytes (50 MB).` });
      return;
    }

    try {
      const objectPath = `/objects/uploads/${randomUUID()}`;
      await db.insert(attachmentBlobsTable).values({
        objectPath,
        contentType: mimetype,
        sizeBytes: size,
        data: buffer,
      });
      res.json({ objectPath, fileName: originalname, contentType: mimetype, sizeBytes: size });
    } catch (error) {
      req.log.error({ err: error }, "Error storing uploaded file");
      res.status(500).json({ error: "Failed to store the uploaded file." });
    }
  },
);

// GET /storage/objects/*path — stream a stored file back. Gate: the object must be
// referenced by an attachment row (so guessed paths return 404), and the caller
// must be an authenticated CannaQMS user. The QMS is intentionally org-wide-readable
// for traceability; add finer ACLs here per parentTable/parentId if needed later.
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  const user = await getOrProvisionCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required to download files." });
    return;
  }
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;

    const [attachment] = await db
      .select()
      .from(attachmentsTable)
      .where(eq(attachmentsTable.objectPath, objectPath))
      .limit(1);
    if (!attachment) {
      res.status(404).json({ error: "Object not found" });
      return;
    }

    const [blob] = await db
      .select()
      .from(attachmentBlobsTable)
      .where(eq(attachmentBlobsTable.objectPath, objectPath))
      .limit(1);
    if (!blob) {
      res.status(404).json({ error: "Object not found" });
      return;
    }

    res.setHeader("Content-Type", blob.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(blob.sizeBytes));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.status(200).end(blob.data);
  } catch (error) {
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
