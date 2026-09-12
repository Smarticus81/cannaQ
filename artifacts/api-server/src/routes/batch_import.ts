import { Router } from "express";
import multer from "multer";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, GIF, WEBP, and PDF files are supported."));
    }
  },
});

const EXTRACTION_PROMPT = `You are an expert document analyzer for a licensed Michigan cannabis processor's electronic Quality Management System (eQMS). Analyze the uploaded batch production record document or image.

Extract ALL batch record information you can find and return a single valid JSON object with this exact structure:

{
  "batchNumber": string or null,
  "productName": string or null,
  "productType": string or null (e.g. "Vape Cartridge", "Edible", "Tincture", "Concentrate", "Flower"),
  "batchType": "Production" or "Remediation" or null,
  "strainName": string or null,
  "productionDate": string or null (ISO format YYYY-MM-DD),
  "outputQuantity": number or null,
  "unitOfMeasure": string or null (e.g. "units", "g", "kg", "mL"),
  "metrcPackageId": string or null,
  "notes": string or null,
  "ingredients": [
    {
      "ingredientName": string,
      "lotNumber": string or null,
      "plannedQuantity": number or null,
      "actualQuantity": number or null,
      "unitOfMeasure": string
    }
  ],
  "testingAgency": string or null,
  "testResult": "Pass" or "Fail" or "Pending" or null,
  "thcPct": number or null,
  "cbdPct": number or null,
  "confidence": "high" or "medium" or "low",
  "extractionNotes": string (briefly describe what you found, any unclear sections, or missing fields)
}

Rules:
- Return ONLY the JSON object, no markdown fences, no explanation.
- If a field is not present in the document, use null.
- For ingredients, return an empty array [] if none found.
- metrcPackageId: capture ONLY a genuine METRC package tag — a long (typically 24-character) alphanumeric package/plant tag, usually labeled "METRC", "Package Tag", "Package ID", or "Tag", and commonly starting with "1A". Do NOT put any other number here. In particular, NEVER use an equipment ID, scale or balance number, instrument/serial number, license number, lot number, order/invoice number, or the document's own batch number as the metrcPackageId. If no genuine METRC package tag is clearly present, return null.
- Dates must be in YYYY-MM-DD format.
- Numbers must be actual numbers, not strings.
- Be thorough — extract every ingredient row from any bill of materials or formulation table.`;

router.post("/batch-records/import", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const { mimetype, buffer } = req.file;
    const base64Data = buffer.toString("base64");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let contentBlock: any;

    if (mimetype === "application/pdf") {
      contentBlock = {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64Data,
        },
      };
    } else {
      contentBlock = {
        type: "image",
        source: {
          type: "base64",
          media_type: mimetype as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: base64Data,
        },
      };
    }

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            contentBlock,
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const block = message.content[0];
    if (block.type !== "text") {
      res.status(500).json({ error: "Unexpected response from AI." });
      return;
    }

    let extracted: unknown;
    try {
      const raw = block.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
      extracted = JSON.parse(raw);
    } catch {
      req.log.error({ rawText: block.text }, "Failed to parse AI extraction JSON");
      res.status(422).json({
        error: "AI could not extract structured data from the document.",
        rawText: block.text,
      });
      return;
    }

    res.json(extracted);
  } catch (err) {
    req.log.error({ err }, "Batch import extraction failed");
    res.status(500).json({ error: "Failed to process document." });
  }
});

export default router;
