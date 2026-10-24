import { createHash } from "node:crypto";
import { z } from "zod";
import { EmployeePayloadSchema, MAX_TOTAL_FILE_BYTES, parseModelJson } from "./contract.js";
import { PmError } from "./types.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export interface OneShotResponseReceipt {
  rawResponseSha256: string;
  normalizedResponseSha256?: string;
  payloadSha256?: string;
  normalization: {
    policy: "pm-oneshot-transport/v1";
    attempted: boolean;
    escapedStringControlCharacters: number;
    identicalFileDuplicatesCollapsed: number;
    actions: Array<{ kind: "escape-unescaped-string-control" | "collapse-identical-file"; count: number }>;
  };
}
export function oneShotResponseReceipt(text: string): OneShotResponseReceipt {
  return { rawResponseSha256: sha(text), normalization: { policy: "pm-oneshot-transport/v1", attempted: false,
    escapedStringControlCharacters: 0, identicalFileDuplicatesCollapsed: 0, actions: [] } };
}

/**
 * Only a lexical transport correction: JSON string controls become their exact
 * escaped representation. Quotes, backslashes, structure and external text are
 * untouched. A control following a backslash is an invalid escape, not repaired.
 */
function escapeStringControls(text: string): { text: string; count: number } {
  const chunks: string[] = [];
  let inside = false, escaped = false, count = 0;
  for (const char of text) {
    if (!inside) { if (char === '"') inside = true; chunks.push(char); continue; }
    if (escaped) { chunks.push(char); escaped = false; continue; }
    if (char === "\\") { chunks.push(char); escaped = true; continue; }
    if (char === '"') { chunks.push(char); inside = false; continue; }
    const code = char.charCodeAt(0);
    if (code < 0x20) {
      chunks.push(`\\u${code.toString(16).padStart(4, "0")}`); count++;
    } else chunks.push(char);
  }
  return { text: chunks.join(""), count };
}

// The raw response is already bounded at 2MiB. Validate every raw file before
// folding, then enforce the unchanged 12 unique-file limit on the final payload.
const RawPayloadSchema = EmployeePayloadSchema.extend({ files: z.array(EmployeePayloadSchema.shape.files.element).min(1) });

/** Employee completion only; the shared planner/JSON and result contracts stay strict. */
export function parseOneShotEmployeeResponse(text: string): {
  payload: z.infer<typeof EmployeePayloadSchema>;
  receipt: OneShotResponseReceipt;
} {
  const receipt = oneShotResponseReceipt(text);
  try {
    // Guard before scanning, and retain exactly the shared parser's response bound.
    if (!text.trim() || Buffer.byteLength(text, "utf8") > 2 * MAX_TOTAL_FILE_BYTES) {
      throw new PmError("INVALID_MODEL_JSON", "模型未返回大小合法的完整交付JSON");
    }
    receipt.normalization.attempted = true;
    const escaped = escapeStringControls(text);
    receipt.normalization.escapedStringControlCharacters = escaped.count;
    if (escaped.count) receipt.normalization.actions.push({ kind: "escape-unescaped-string-control", count: escaped.count });
    receipt.normalizedResponseSha256 = sha(escaped.text);
    // Strict parsing still rejects missing quotes/braces/commas, invalid escapes,
    // truncation, trailing explanations and every unknown payload/file field.
    const parsed = RawPayloadSchema.parse(parseModelJson(escaped.text));
    const files: typeof parsed.files = [];
    const seen = new Map<string, (typeof parsed.files)[number]>();
    for (const file of parsed.files) {
      const prior = seen.get(file.path.toLowerCase());
      if (prior) {
        if (prior.path !== file.path || prior.content !== file.content
          || !Buffer.from(prior.content, "utf8").equals(Buffer.from(file.content, "utf8"))) {
          throw new PmError("DUPLICATE_ARTIFACT", "同名或大小写冲突产物的内容不同，拒绝选择或覆盖");
        }
        receipt.normalization.identicalFileDuplicatesCollapsed++;
        const action = receipt.normalization.actions.find((item) => item.kind === "collapse-identical-file");
        if (action) action.count++;
        else receipt.normalization.actions.push({ kind: "collapse-identical-file", count: 1 });
      } else { files.push(file); seen.set(file.path.toLowerCase(), file); }
    }
    const payload = EmployeePayloadSchema.parse({ ...parsed, files });
    receipt.payloadSha256 = sha(JSON.stringify(payload));
    return { payload, receipt };
  } catch (error) {
    const failure = error instanceof Error ? error : new PmError("INVALID_MODEL_JSON", "员工响应无法严格解析");
    Object.assign(failure, { oneShotReceipt: receipt });
    throw failure;
  }
}
