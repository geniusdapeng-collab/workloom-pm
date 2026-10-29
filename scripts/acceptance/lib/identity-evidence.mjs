/** Version text may be rendered with presentation spacing that differs from data. */
export function compactIdentityText(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

export function agentIdentityEvidenceOk(identity, expectedVersion) {
  const text = String(identity ?? "");
  return text.includes("来源行业包")
    && compactIdentityText(text).includes(compactIdentityText(expectedVersion));
}

export function agentProfileHeaderOk(text) {
  return /(?:员工|成员)档案 · \S/.test(String(text ?? ""));
}
