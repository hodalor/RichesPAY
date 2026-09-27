import dns from "node:dns/promises";
import net from "node:net";

import ipaddr from "ipaddr.js";

const blockedExactIps = new Set([
  "100.100.100.200",
  "169.254.169.254",
  "169.254.170.2",
  "fd00:ec2::254"
]);

const blockedIpv4Cidrs = ["198.18.0.0/15"] as const;

export type WebhookLookupFn = (hostname: string) => Promise<string[]>;

export async function defaultWebhookLookup(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, {
    all: true,
    verbatim: true
  });

  return results.map((item) => item.address);
}

export async function resolveWebhookTargetAddress(
  target: URL,
  lookup: WebhookLookupFn = defaultWebhookLookup
): Promise<string> {
  if (target.protocol !== "https:") {
    throw new Error("Webhook endpoints must use HTTPS.");
  }

  if (target.username || target.password) {
    throw new Error("Webhook endpoints cannot include basic-auth credentials.");
  }

  const addresses = net.isIP(target.hostname)
    ? [target.hostname]
    : await lookup(target.hostname);

  if (addresses.length === 0) {
    throw new Error("Webhook endpoint DNS lookup returned no addresses.");
  }

  for (const address of addresses) {
    if (isBlockedWebhookAddress(address)) {
      throw new Error(`Webhook endpoint resolves to a blocked IP address: ${address}`);
    }
  }

  return addresses[0]!;
}

export function isBlockedWebhookAddress(ip: string): boolean {
  const normalized = ipaddr.parse(ip).toNormalizedString();
  if (blockedExactIps.has(normalized)) {
    return true;
  }

  const address = ipaddr.parse(normalized);
  const range = address.range();

  if (
    range === "loopback" ||
    range === "linkLocal" ||
    range === "private" ||
    range === "uniqueLocal" ||
    range === "unspecified" ||
    range === "carrierGradeNat"
  ) {
    return true;
  }

  if (address.kind() === "ipv4") {
    return blockedIpv4Cidrs.some((entry) => {
      const [rangeAddress, prefixLength] = ipaddr.parseCIDR(entry);
      return address.match([rangeAddress, prefixLength]);
    });
  }

  return false;
}
