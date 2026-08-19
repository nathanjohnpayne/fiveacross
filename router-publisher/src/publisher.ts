import { createHash } from "node:crypto";

export const ROUTER_REPLICA_SYNC_PATH = "/__internal/hostname-replicas/v1";

export const ROUTER_REPLICA_PUBLISHER_HEADERS = {
  keyVersion: "x-registry-key-version",
  publisherEpoch: "x-registry-publisher-epoch",
  issuedAt: "x-registry-issued-at",
  bodySignature: "x-registry-body-signature",
} as const;

type Edition = "fiveacross" | "vacay" | "gcb";
type PathNamespace = "fiveacross.app" | "vacaybingo.com" | null;

export type RouterReplicaDesired = {
  schemaVersion: 1;
  revision: string;
  host: string;
  desired:
    | {
        kind: "route";
        eventId: string;
        status: "active" | "disabled" | "archived";
        slug: string;
        edition: Edition;
        pathNamespace: PathNamespace;
      }
    | {
        kind: "root";
        root: "doorway" | "not-found";
        edition: Edition;
        pathNamespace: PathNamespace;
      }
    | { kind: "tombstone" };
  updatedAt: string;
};

export type RouterReplicaPublishResult = {
  result: "applied" | "replay" | "ignored-stale";
};

export type RouterReplicaPublisherConfig = {
  registryOrigin: string;
  publisherEpoch: string;
  keyVersion: string;
};

export type RouterReplicaPublisherDeps = {
  now: () => number;
  getIdentityToken: (audience: string) => Promise<string>;
  signDigest: (request: {
    keyVersion: string;
    digest: Uint8Array;
  }) => Promise<Uint8Array>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
};

type RouterReplicaPublishErrorCode =
  | "request-invalid"
  | "identity-token-unavailable"
  | "signing-unavailable"
  | "registry-unavailable"
  | "registry-rejected"
  | "response-invalid";

export class RouterReplicaPublishError extends Error {
  readonly code: RouterReplicaPublishErrorCode;
  readonly status?: number;

  constructor(code: RouterReplicaPublishErrorCode, status?: number) {
    super(
      status === undefined
        ? `router replica publish failed: ${code}`
        : `router replica publish failed: ${code} (${status})`,
    );
    this.name = "RouterReplicaPublishError";
    this.code = code;
    this.status = status;
  }
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function isExactRegistryOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.endsWith(".workers.dev") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.origin === origin
    );
  } catch {
    return false;
  }
}

function isKmsKeyVersionName(keyVersion: string): boolean {
  return /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[1-9]\d*$/.test(
    keyVersion,
  );
}

export async function publishRouterReplica(
  payload: RouterReplicaDesired,
  config: RouterReplicaPublisherConfig,
  deps: RouterReplicaPublisherDeps,
): Promise<RouterReplicaPublishResult> {
  const body = JSON.stringify(payload);
  const bodyBytes = new TextEncoder().encode(body);
  const issuedAt = deps.now();
  if (
    !isExactRegistryOrigin(config.registryOrigin) ||
    !/^[1-9]\d*$/.test(config.publisherEpoch) ||
    !isKmsKeyVersionName(config.keyVersion) ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt <= 0 ||
    bodyBytes.byteLength > 2_048
  ) {
    throw new RouterReplicaPublishError("request-invalid");
  }

  const endpoint = `${config.registryOrigin}${ROUTER_REPLICA_SYNC_PATH}`;
  const signatureInput = [
    "v1",
    "POST",
    ROUTER_REPLICA_SYNC_PATH,
    String(issuedAt),
    config.publisherEpoch,
    hex(sha256(bodyBytes)),
  ].join("\n");
  let signature: Uint8Array;
  try {
    signature = await deps.signDigest({
      keyVersion: config.keyVersion,
      digest: sha256(new TextEncoder().encode(signatureInput)),
    });
  } catch {
    throw new RouterReplicaPublishError("signing-unavailable");
  }

  let token: string;
  try {
    token = await deps.getIdentityToken(endpoint);
  } catch {
    throw new RouterReplicaPublishError("identity-token-unavailable");
  }

  let response: Response;
  try {
    response = await deps.fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [ROUTER_REPLICA_PUBLISHER_HEADERS.keyVersion]: config.keyVersion,
        [ROUTER_REPLICA_PUBLISHER_HEADERS.publisherEpoch]:
          config.publisherEpoch,
        [ROUTER_REPLICA_PUBLISHER_HEADERS.issuedAt]: String(issuedAt),
        [ROUTER_REPLICA_PUBLISHER_HEADERS.bodySignature]:
          Buffer.from(signature).toString("base64"),
      },
      body,
    });
  } catch {
    throw new RouterReplicaPublishError("registry-unavailable");
  }

  if (!response.ok) {
    throw new RouterReplicaPublishError("registry-rejected", response.status);
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new RouterReplicaPublishError("response-invalid", response.status);
  }

  const validResults = new Set(["applied", "replay", "ignored-stale"]);
  if (
    typeof responseBody !== "object" ||
    responseBody === null ||
    Array.isArray(responseBody) ||
    Object.keys(responseBody).length !== 1 ||
    !("result" in responseBody) ||
    typeof responseBody.result !== "string" ||
    !validResults.has(responseBody.result)
  ) {
    throw new RouterReplicaPublishError("response-invalid", response.status);
  }

  return responseBody as RouterReplicaPublishResult;
}
