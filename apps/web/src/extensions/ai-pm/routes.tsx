import PmDelivery from "./PmDelivery";

/** AI 产品经理示例能力完全由 Bundle 声明和服务端权限投影放行。 */
export const industryRoutes = [{
  path: "/development",
  legacyPaths: ["/p25"],
  capabilityId: "ai-pm.development",
  element: <PmDelivery />,
}] as const;
