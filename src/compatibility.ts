import { loadPackageInfo } from "./package-info.ts";

export const KAVI_PROTOCOL_VERSION = 1;

export interface KaviRuntimeIdentity {
  version: string;
  protocolVersion: number;
}

export interface DaemonCompatibility {
  compatible: boolean;
  localVersion: string;
  localProtocolVersion: number;
  remoteVersion: string | null;
  remoteProtocolVersion: number | null;
  reason: string | null;
}

let runtimeIdentityPromise: Promise<KaviRuntimeIdentity> | null = null;

function normalizeVersion(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeProtocolVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function loadRuntimeIdentity(): Promise<KaviRuntimeIdentity> {
  runtimeIdentityPromise ??= loadPackageInfo().then((info) => ({
    version: info.version,
    protocolVersion: KAVI_PROTOCOL_VERSION
  }));

  return await runtimeIdentityPromise;
}

export function evaluateDaemonCompatibility(
  session: {
    daemonVersion?: string | null;
    protocolVersion?: number | null;
  },
  local: KaviRuntimeIdentity
): DaemonCompatibility {
  const remoteVersion = normalizeVersion(session.daemonVersion);
  const remoteProtocolVersion = normalizeProtocolVersion(session.protocolVersion);

  if (remoteProtocolVersion === null) {
    return {
      compatible: false,
      localVersion: local.version,
      localProtocolVersion: local.protocolVersion,
      remoteVersion,
      remoteProtocolVersion,
      reason: "The running daemon predates protocol tracking."
    };
  }

  if (remoteProtocolVersion !== local.protocolVersion) {
    return {
      compatible: false,
      localVersion: local.version,
      localProtocolVersion: local.protocolVersion,
      remoteVersion,
      remoteProtocolVersion,
      reason: `Protocol mismatch: daemon=${remoteProtocolVersion}, client=${local.protocolVersion}.`
    };
  }

  if (remoteVersion !== local.version) {
    return {
      compatible: false,
      localVersion: local.version,
      localProtocolVersion: local.protocolVersion,
      remoteVersion,
      remoteProtocolVersion,
      reason: `Version mismatch: daemon=${remoteVersion ?? "unknown"}, client=${local.version}.`
    };
  }

  return {
    compatible: true,
    localVersion: local.version,
    localProtocolVersion: local.protocolVersion,
    remoteVersion,
    remoteProtocolVersion,
    reason: null
  };
}

export function formatRestartRequiredMessage(
  action: string,
  compatibility: DaemonCompatibility
): string {
  const daemonLabel = `daemon ${compatibility.remoteVersion ?? "unknown"} / protocol ${compatibility.remoteProtocolVersion ?? "unknown"}`;
  const clientLabel = `client ${compatibility.localVersion} / protocol ${compatibility.localProtocolVersion}`;
  return `${action} is blocked because this repo session is attached to a stale Kavi daemon (${daemonLabel}; ${clientLabel}). Run "kavi restart" in this repository, then try again.`;
}
