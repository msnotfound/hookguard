import { lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

import { config } from "./config.js";

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const lookupAll = promisify(dnsLookup);

export function isLocalReceiverUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const configuredHost = config.host.toLowerCase();
  const allowedHosts = new Set([...localHosts, configuredHost]);
  return url.protocol === "http:" &&
    allowedHosts.has(url.hostname.toLowerCase()) &&
    port === config.port &&
    url.pathname.startsWith("/receiver/");
}

export async function validateTargetUrl(value, { allowLocalReceiver = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw destinationError("Enter a valid destination URL.");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw destinationError("Destination must use HTTPS.");
  if (url.username || url.password) throw destinationError("Destination URLs cannot contain credentials.");
  if (url.hash) throw destinationError("Destination URLs cannot contain fragments.");
  if (allowLocalReceiver && isLocalReceiverUrl(url)) return url.toString();
  if (url.protocol !== "https:") throw destinationError("External destinations must use HTTPS.");

  let addresses;
  try {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (ipaddr.isValid(hostname)) {
      addresses = [{ address: hostname }];
    } else {
      addresses = await lookupAll(hostname, { all: true, verbatim: true });
    }
  } catch {
    throw destinationError("Destination host could not be resolved.");
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw destinationError("Destination resolves to a private or reserved network address.");
  }
  return url.toString();
}

function destinationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function createSafeDispatcher(value) {
  const url = value instanceof URL ? value : new URL(value);
  const localReceiver = isLocalReceiverUrl(url);
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (localReceiver) return dnsLookup(hostname, options, callback);
        dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses?.length || addresses.some(({ address }) => !isPublicAddress(address))) {
            return callback(new Error("Destination resolved to a private or reserved network address."));
          }
          if (options?.all) return callback(null, addresses);
          return callback(null, addresses[0].address, addresses[0].family);
        });
      }
    }
  });
}

export function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
