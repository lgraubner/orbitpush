import {
  addHostname,
  api,
  checkRuleLimit,
  connectHostname,
  findHostname,
  getPullZone,
  isConnected,
  logDnsRecord,
  purgeCache,
  type PullZone,
  removeHostname,
  syncRules,
} from "@/bunny.ts";
import { aliasProblem, type Config, CONFIG_FILE, hostnameProblem, writeConfig } from "@/config.ts";
import { log } from "@/log.ts";
import { managedRules } from "@/rules.ts";

const WAIT_MS = 15 * 60_000;
const RECHECK_SECONDS = [5, 10, 20, 40, 60];

type Options = { primary?: boolean; interactive: boolean };

const USAGE = "Usage: orbitpush domains add|remove <host>, or orbitpush domains list";

export class Cancelled extends Error {}

export async function domains(
  apiKey: string,
  config: Config,
  [action, host, ...extra]: (string | undefined)[],
  options: Options,
) {
  if (action === "list" && host === undefined) return listDomains(apiKey, config);
  if (action !== "add" && action !== "remove") throw new Error(USAGE);
  if (extra.length) {
    throw new Error(`domains ${action} takes one hostname at a time. ${USAGE}`);
  }

  const problem = host ? hostnameProblem([host]) : "a hostname is missing";
  if (!host || problem) throw new Error(`Invalid hostname: ${problem}`);

  if (action === "add") return addDomain(apiKey, config, host.toLowerCase(), options);
  return removeDomain(apiKey, config, host.toLowerCase());
}

async function addDomain(apiKey: string, config: Config, host: string, options: Options) {
  const pullZone = await getPullZone(apiKey, config.pullZoneId);
  const cdnHost = `${pullZone.Name}.b-cdn.net`;
  const primary = config.domain?.toLowerCase();

  if (options.primary && host === primary) {
    log.success(`${host} is already the primary domain`);
    return;
  }

  if (!primary) {
    config = { ...config, domain: host };
  } else if (host !== primary && !hasHost(config.aliases, host)) {
    config = { ...config, aliases: [...config.aliases, host] };
    const problem = aliasProblem(config);
    if (problem) throw new Error(`Cannot add ${host}: ${problem}`);
  }

  let hostname = findHostname(pullZone, host);
  if (!hostname) {
    await addHostname(apiKey, config.pullZoneId, host);
    hostname = { Value: host, HasCertificate: false, ForceSSL: false };
  }

  await writeConfig(config, { overwrite: true });

  const retry = `orbitpush domains add ${host}${options.primary ? " --primary" : ""}`;
  const connection = await waitForConnection(apiKey, config.pullZoneId, host, hostname, {
    cdnHost,
    interactive: options.interactive,
    retry,
  });
  if (connection.status !== "connected") {
    const stays = options.primary && host !== primary ? " It stays an alias for now." : "";
    throw new Error(
      connection.status === "dns"
        ? `${host} is not connected yet: its DNS does not point to ${cdnHost}.${stays} Run \`${retry}\` again in a few minutes, once the record is set. If the domain uses a proxy such as Cloudflare's, turn it off for this record.`
        : `${host} has no SSL certificate.${stays} bunny.net: ${connection.reason}`,
    );
  }

  if (options.primary && primary && host !== primary) {
    config = {
      ...config,
      domain: host,
      aliases: [primary, ...config.aliases.filter((alias) => alias.toLowerCase() !== host)],
    };
    await writeConfig(config, { overwrite: true });
  }

  const domain = config.domain?.toLowerCase();
  const aliasRedirects = host === domain || isConnected(pullZone, domain);
  await applyRules(apiKey, config, pullZone, { aliasRedirects });

  logAdded(host, config, { domain, previousPrimary: primary, aliasRedirects });
}

function logAdded(
  host: string,
  config: Config,
  {
    domain,
    previousPrimary,
    aliasRedirects,
  }: { domain: string | undefined; previousPrimary: string | undefined; aliasRedirects: boolean },
) {
  if (host !== domain && !aliasRedirects) {
    log.warn(
      `${host} is connected and will redirect to ${config.domain} once it has HTTPS. Run \`orbitpush domains add ${config.domain}\` to finish it.`,
    );
  } else if (host !== domain) {
    log.success(`${host} is connected and redirects to ${config.domain}`);
  } else if (previousPrimary && previousPrimary !== host) {
    const verb = config.aliases.length === 1 ? "redirects" : "redirect";
    log.success(`${host} is now the primary domain. ${config.aliases.join(", ")} ${verb} to it.`);
  } else {
    log.success(`${host} is connected: https://${host}`);
  }
}

async function removeDomain(apiKey: string, config: Config, host: string) {
  const primary = config.domain?.toLowerCase();
  if (host === primary && config.aliases.length) {
    throw new Error(
      `${host} has aliases that redirect to it (${config.aliases.join(", ")}). Remove them first, or make another domain primary: \`orbitpush domains add <host> --primary\`.`,
    );
  }

  const pullZone = await getPullZone(apiKey, config.pullZoneId);
  const hostname = findHostname(pullZone, host);
  if (host !== primary && !hasHost(config.aliases, host) && !hostname) {
    throw new Error(`${host} is not a domain of this site. Run \`orbitpush domains list\`.`);
  }

  config =
    host === primary
      ? { ...config, domain: undefined }
      : { ...config, aliases: config.aliases.filter((alias) => alias.toLowerCase() !== host) };
  await writeConfig(config, { overwrite: true });

  if (hostname) await removeHostname(apiKey, config.pullZoneId, hostname.Value);

  await applyRules(apiKey, config, pullZone, {
    aliasRedirects: isConnected(pullZone, config.domain),
  });
  log.success(`Removed ${host}. It no longer serves the site.`);
}

async function listDomains(apiKey: string, config: Config) {
  const pullZone = await getPullZone(apiKey, config.pullZoneId);
  const cdnHost = `${pullZone.Name}.b-cdn.net`;
  const hosts = config.domain ? [config.domain, ...config.aliases] : [];

  if (!hosts.length) {
    log.step("No domains yet. Add one with `orbitpush domains add <host>`.");
  }

  const others = pullZone.Hostnames.map((h) => h.Value).filter(
    (host) => host.toLowerCase() !== cdnHost.toLowerCase() && !hasHost(hosts, host),
  );
  const width = Math.max(0, ...[...hosts, ...others].map((host) => host.length));

  let connected = true;
  for (const host of hosts) {
    const role = host === config.domain ? "primary domain" : `redirects to ${config.domain}`;
    const hostname = findHostname(pullZone, host);
    if (isConnected(pullZone, host)) {
      log.success(`${host.padEnd(width)}  connected, ${role}`);
    } else if (hostname) {
      connected = false;
      log.warn(`${host.padEnd(width)}  waiting for DNS: ${host} CNAME ${cdnHost}`);
    } else {
      connected = false;
      log.warn(`${host.padEnd(width)}  not added yet. Run \`orbitpush domains add ${host}\`.`);
    }
  }

  for (const host of others) {
    log.warn(`${host.padEnd(width)}  on the pull zone but not in ${CONFIG_FILE}`);
  }

  return connected;
}

async function waitForConnection(
  apiKey: string,
  pullZoneId: number,
  host: string,
  hostname: PullZone["Hostnames"][number],
  { cdnHost, interactive, retry }: { cdnHost: string; interactive: boolean; retry: string },
) {
  let connection = await connectHostname(apiKey, pullZoneId, host, hostname);
  if (connection.status !== "dns") return connection;

  logDnsRecord(host, cdnHost, "Add this DNS record at your DNS provider:");
  if (!interactive) return connection;

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);

  try {
    const deadline = Date.now() + WAIT_MS;
    for (let check = 0; connection.status === "dns" && Date.now() < deadline; check++) {
      const seconds = RECHECK_SECONDS[Math.min(check, RECHECK_SECONDS.length - 1)];
      log.status(`Waiting for DNS of ${host}, next check in ${seconds}s (Ctrl+C to stop)`);
      await sleep(Math.min(seconds * 1000, deadline - Date.now()), controller.signal);
      connection = await connectHostname(apiKey, pullZoneId, host, hostname);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    throw new Cancelled(`Stopped waiting. Run \`${retry}\` again once the record is set.`);
  } finally {
    process.off("SIGINT", stop);
  }

  return connection;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);

    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function applyRules(
  apiKey: string,
  config: Config,
  pullZone: PullZone,
  { aliasRedirects }: { aliasRedirects: boolean },
) {
  const { rules } = managedRules(config, { aliasRedirects });
  checkRuleLimit(pullZone, rules);

  // bunny.net shares one cache across hostnames unless this is set, so the noindex header of
  // b-cdn.net would be served on the domain from cache
  await api(apiKey, {
    method: "POST",
    path: `/pullzone/${config.pullZoneId}`,
    body: { EnableHostnameVary: true },
  });
  const changes = await syncRules(apiKey, pullZone, rules);
  if (changes.added || changes.removed) await purgeCache(apiKey, config.pullZoneId);
}

function hasHost(hosts: string[], host: string) {
  return hosts.some((h) => h.toLowerCase() === host.toLowerCase());
}
