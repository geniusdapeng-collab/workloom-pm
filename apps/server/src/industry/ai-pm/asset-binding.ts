import type { PmAssetBinding } from "./types.js";

/** Keep a private immutable snapshot before an injected executor can touch its input. */
export function snapshotPmAssetBinding(binding: PmAssetBinding | undefined): PmAssetBinding | undefined {
  if (!binding) return undefined;
  return Object.freeze({ ...binding, skills: Object.freeze(binding.skills.map((skill) => Object.freeze({ ...skill }))) });
}

/** A worker/model cannot self-certify provenance, even if no real catalog was injected. */
export function withPmAssetBinding(receipt: Record<string, unknown> | undefined, binding: PmAssetBinding | undefined): Record<string, unknown> {
  const { assetBinding: _untrustedBinding, assetBindingSource: _untrustedSource, ...rest } = receipt ?? {};
  return { ...rest, ...(binding ? { assetBinding: structuredClone(binding), assetBindingSource: "verified-catalog" } : {}) };
}
