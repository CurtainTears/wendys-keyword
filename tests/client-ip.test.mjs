import { test } from "node:test";
import assert from "node:assert/strict";
import { createClientIPResolver } from "../server/client-ip.mjs";

const request = (peer, forwarded, other = {}) => ({
  socket: { remoteAddress: peer },
  headers: {
    ...(forwarded === undefined ? {} : { "x-forwarded-for": forwarded }),
    ...other,
  },
});

test("Forwarding headers have no authority by default or from an untrusted peer", () => {
  const req = request("::ffff:203.0.113.4", "198.51.100.1", {
    "x-real-ip": "198.51.100.2",
    forwarded: "for=198.51.100.3",
    "x-keyword-client-ip": "198.51.100.4",
  });
  assert.equal(createClientIPResolver()(req), "203.0.113.4");
  assert.equal(createClientIPResolver("192.0.2.1")(req), "203.0.113.4");
});

test("Trusted proxy chains stop at the closest untrusted IP, ignoring forged prefixes", () => {
  const resolve = createClientIPResolver("10.0.0.0/24,2001:db8:ffff::/48");
  assert.equal(
    resolve(request("10.0.0.2", "198.51.100.99, 203.0.113.10")),
    "203.0.113.10",
  );
  assert.equal(
    resolve(request("10.0.0.2", "invalid attacker prefix, 203.0.113.10")),
    "203.0.113.10",
  );
  assert.equal(
    resolve(
      request("2001:db8:ffff::2", "198.51.100.99, 203.0.113.20, 10.0.0.2"),
    ),
    "203.0.113.20",
  );
  assert.equal(
    resolve(request("10.0.0.2", "198.51.100.99, 192.0.2.50")),
    "192.0.2.50",
  );
});

test("IPv4-mapped and alternate IPv6 spellings have one canonical source identity", () => {
  const resolve = createClientIPResolver("127.0.0.1");
  assert.equal(
    resolve(request("::ffff:127.0.0.1", "::ffff:203.0.113.9")),
    "203.0.113.9",
  );
  assert.equal(
    resolve(request("127.0.0.1", "2001:0DB8:0000:0000:0000:0000:0000:0001")),
    "2001:db8::1",
  );
  assert.equal(
    createClientIPResolver("::ffff:127.0.0.1")(
      request("127.0.0.1", "203.0.113.9"),
    ),
    "203.0.113.9",
  );
});

test("Missing or malformed forwarding data cannot invent a source; invalid trust config fails explicitly", () => {
  const resolve = createClientIPResolver("127.0.0.1");
  for (const forwarded of [
    undefined,
    "",
    "not-an-ip",
    "203.0.113.1:1234",
    "x".repeat(2049),
    ["203.0.113.1"],
  ])
    assert.equal(resolve(request("127.0.0.1", forwarded)), "127.0.0.1");
  for (const config of [
    "*",
    "localhost",
    "0.0.0.0/0",
    "::/0",
    "192.0.2.1/33",
    "2001:db8::1/129",
    "127.0.0.1/32/8",
    "127.0.0.1/nope",
  ])
    assert.throws(() => createClientIPResolver(config), /TRUSTED_PROXY_CIDRS/);
});
