import { BlockList, isIP } from "node:net";

function canonicalIP(value) {
  if (typeof value !== "string") return null;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  let address;
  try {
    address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = address.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if (!mapped) return address;
  const high = parseInt(mapped[1], 16),
    low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function createClientIPResolver(trustedProxyCidrs = "") {
  const trusted = new BlockList();
  if (typeof trustedProxyCidrs !== "string")
    throw new Error("TRUSTED_PROXY_CIDRS 必须是逗号分隔的 IP/CIDR 列表");
  for (const entry of trustedProxyCidrs
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [address, prefix, ...extra] = entry.split("/");
    const version = isIP(address),
      family = version === 4 ? "ipv4" : "ipv6";
    if (
      !canonicalIP(address) ||
      extra.length ||
      (prefix !== undefined &&
        (!/^\d{1,3}$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw new Error(
        "TRUSTED_PROXY_CIDRS 只接受具体 IP 或非全网 CIDR，不能使用主机名、* 或 /0",
      );
    if (prefix === undefined) trusted.addAddress(address, family);
    else trusted.addSubnet(address, Number(prefix), family);
  }
  const isTrusted = (address) =>
    trusted.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
  return (req) => {
    let address = canonicalIP(req.socket.remoteAddress);
    if (!address) return "unknown";
    const forwarded = req.headers["x-forwarded-for"];
    if (
      !isTrusted(address) ||
      typeof forwarded !== "string" ||
      forwarded.length > 2048
    )
      return address;
    // The closest trusted proxy appends/overwrites with its actual peer. Walk
    // from the socket backwards; a client's forged left-hand prefix never wins.
    for (const value of forwarded.split(",").reverse()) {
      if (!isTrusted(address)) break;
      const next = canonicalIP(value.trim());
      if (!next) break;
      address = next;
    }
    return address;
  };
}
