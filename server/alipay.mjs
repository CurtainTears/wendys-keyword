import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AlipaySdk } from "alipay-sdk";
import { yuan } from "../shared/payment.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const SANDBOX_GATEWAY =
  "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
export const PRODUCTION_GATEWAY = "https://openapi.alipay.com/gateway.do";

function protectedJSON(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error("支付宝配置必须是仅所有者可读写的普通文件（0600）");
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}
function required(config, key, pattern) {
  if (typeof config[key] !== "string" || !pattern.test(config[key]))
    throw new Error(`支付宝配置字段 ${key} 缺失或格式无效`);
  return config[key];
}

// Off by default: ordinary login, manual invitations and learning do not need
// payment credentials. Sandbox credentials never become a production fallback.
export function loadAlipayConfig({
  env = process.env,
  production = false,
  origin,
} = {}) {
  const mode = env.ALIPAY_MODE || "off";
  if (mode === "off") return null;
  if (!["sandbox", "production"].includes(mode))
    throw new Error("ALIPAY_MODE 只接受 off、sandbox 或 production");
  if (mode === "sandbox" && production)
    throw new Error("生产运行模式禁止加载沙箱配置，请使用独立测试服务");
  const filename =
    mode === "sandbox"
      ? path.join(ROOT, ".alipay-sandbox.json")
      : env.ALIPAY_PRODUCTION_CONFIG;
  if (!filename || !path.isAbsolute(filename))
    throw new Error("ALIPAY_PRODUCTION_CONFIG 必须指向所有者挂载的绝对路径");
  if (mode === "production" && path.resolve(filename).startsWith(ROOT))
    throw new Error("生产支付配置必须放在项目目录之外，禁止打包进镜像");
  const raw = protectedJSON(filename);
  const application = mode === "sandbox" ? raw.appIds?.[0] : raw;
  if (!application) throw new Error("支付宝应用配置缺失");
  const config = {
    mode,
    appId: required(application, "appId", /^\d{16,32}$/),
    privateKey: required(
      application,
      mode === "sandbox" ? "appPrivatePkcsKey" : "privateKey",
      /^[A-Za-z0-9+/=]+$/,
    ),
    alipayPublicKey: required(
      application,
      "alipayPublicKey",
      /^[A-Za-z0-9+/=]+$/,
    ),
    sellerId:
      mode === "sandbox"
        ? required(raw.sandboxAccounts?.partner || {}, "userId", /^\d{16,32}$/)
        : required(raw, "sellerId", /^\d{16,32}$/),
    gateway: mode === "sandbox" ? SANDBOX_GATEWAY : PRODUCTION_GATEWAY,
    returnUrl: new URL("/payment/return", origin).href,
    notifyUrl: "",
  };
  if (raw.gateway && raw.gateway !== config.gateway)
    throw new Error("支付宝网关与选定环境不一致");
  if (mode === "production" || env.ALIPAY_NOTIFY_URL) {
    const notify = new URL(
      env.ALIPAY_NOTIFY_URL || new URL("/api/payments/alipay/notify", origin),
    );
    if (
      notify.protocol !== "https:" ||
      notify.origin !== new URL(origin).origin ||
      notify.pathname !== "/api/payments/alipay/notify" ||
      notify.search ||
      notify.hash
    )
      throw new Error(
        "支付宝通知必须为本站 /api/payments/alipay/notify 的公网 HTTPS 地址",
      );
    config.notifyUrl = notify.href;
  }
  return config;
}

export function createAlipayGateway(config) {
  const sdk = new AlipaySdk({
    appId: config.appId,
    privateKey: config.privateKey,
    alipayPublicKey: config.alipayPublicKey,
    gateway: config.gateway,
    keyType: "PKCS1",
    signType: "RSA2",
    camelcase: false,
    timeout: 10000,
  });
  return {
    config,
    sdk,
    payURL(order) {
      const options = {
        returnUrl: config.returnUrl,
        bizContent: {
          out_trade_no: order.out_trade_no,
          total_amount: yuan(order.amount_fen),
          subject: "KeyWord 普通账号注册邀请码",
          product_code: "FAST_INSTANT_TRADE_PAY",
          time_expire: alipayTime(order.expires_at),
        },
      };
      if (config.notifyUrl) options.notifyUrl = config.notifyUrl;
      // The installed SDK explicitly supports GET links. Never treat its POST
      // form HTML as a URL, and do not relax the application's CSP for payment.
      const url = sdk.pageExec("alipay.trade.page.pay", "GET", options);
      const parsed = new URL(url);
      if (parsed.origin + parsed.pathname !== config.gateway)
        throw new Error("支付宝支付地址校验失败");
      return url;
    },
    verify(params) {
      return (
        params.app_id === config.appId &&
        params.sign_type === "RSA2" &&
        sdk.checkNotifySignV2(params)
      );
    },
    // Never log SDK errors or full requests: they can contain signed parameters.
    exec(method, bizContent) {
      return sdk.exec(method, { bizContent }, { validateSign: true });
    },
  };
}

export function alipayTime(timestamp) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(timestamp))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
