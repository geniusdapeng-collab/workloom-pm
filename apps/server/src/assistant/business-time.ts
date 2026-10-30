const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

/** Business dates in WorkLoom PM are Chinese calendar dates, not UTC dates. */
export function assistantBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
    throw new Error("无法生成 Asia/Shanghai 业务日期");
  }
  return `${year}-${month}-${day}`;
}
