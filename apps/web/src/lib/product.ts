declare const __WORKLOOM_PRODUCT_NAME__: string;
declare const __WORKLOOM_PRODUCT_ID__: string;
declare const __WORKLOOM_DEMO_WORKSPACE__: string;
declare const __WORKLOOM_DEMO_MEMBER__: string;
declare const __WORKLOOM_SECRETARY_AUTO_SCAN__: boolean;

/** 受保护产品身份由 Vite 从仓库根 product.manifest.json 注入。 */
export const PRODUCT_NAME = __WORKLOOM_PRODUCT_NAME__;
/** 自动事件扫描会写入收件箱；产品可显式关闭，已有收件箱仍以只读方式更新。 */
export const SECRETARY_AUTO_SCAN = __WORKLOOM_SECRETARY_AUTO_SCAN__;
export const DEMO_WORKSPACE = (import.meta.env.VITE_DEMO_WORKSPACE as string | undefined) ?? __WORKLOOM_DEMO_WORKSPACE__;
export const DEMO_MEMBER = (import.meta.env.VITE_DEMO_MEMBER as string | undefined) ?? __WORKLOOM_DEMO_MEMBER__;
export const storageKey = (suffix: string) => `workloom:${__WORKLOOM_PRODUCT_ID__}:b-pc:${suffix}`;
