import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ROUTER_REPLICA_SYNC_PATH,
  publishRouterReplica,
  type RouterReplicaPublisherDeps,
} from "../../router-publisher/src/publisher";

const REGISTRY_ORIGIN = "https://fiveacross-registry.example.workers.dev";
const AUDIENCE = `${REGISTRY_ORIGIN}/__internal/hostname-replicas/v1`;
const KEY_VERSION =
  "projects/fiveacross/locations/us/keyRings/event-router/cryptoKeys/publisher/cryptoKeyVersions/7";
const ISSUED_AT = 1_776_297_600_123;
const SIGNATURE = Uint8Array.from([0, 1, 2, 253, 254, 255]);
const BODY =
  '{"schemaVersion":1,"revision":"7","host":"weekend.fiveacross.app","desired":{"kind":"route","eventId":"weekend-2026","status":"active","slug":"weekend","edition":"vacay","pathNamespace":null},"updatedAt":"2026-04-15T12:00:00.000Z"}';

const PAYLOAD = {
  schemaVersion: 1 as const,
  revision: "7",
  host: "weekend.fiveacross.app",
  desired: {
    kind: "route" as const,
    eventId: "weekend-2026",
    status: "active" as const,
    slug: "weekend",
    edition: "vacay",
    pathNamespace: null,
  },
  updatedAt: "2026-04-15T12:00:00.000Z",
};

function sha256(input: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input, "utf8").digest());
}

function makeDeps(response: Response = Response.json({ result: "applied" })) {
  const getIdentityToken = vi.fn(async () => "google-oidc-token");
  const signDigest = vi.fn(async () => SIGNATURE);
  const fetch = vi.fn(async () => response);

  const deps: RouterReplicaPublisherDeps = {
    now: () => ISSUED_AT,
    getIdentityToken,
    signDigest,
    fetch,
  };

  return { deps, getIdentityToken, signDigest, fetch };
}

describe("router replica publisher", () => {
  it("authenticates and signs the exact registry request", async () => {
    const harness = makeDeps();

    await expect(
      publishRouterReplica(
        PAYLOAD,
        {
          registryOrigin: REGISTRY_ORIGIN,
          publisherEpoch: "3",
          keyVersion: KEY_VERSION,
        },
        harness.deps,
      ),
    ).resolves.toEqual({ result: "applied" });

    expect(ROUTER_REPLICA_SYNC_PATH).toBe("/__internal/hostname-replicas/v1");
    expect(harness.getIdentityToken).toHaveBeenCalledExactlyOnceWith(AUDIENCE);
    expect(harness.signDigest).toHaveBeenCalledExactlyOnceWith({
      keyVersion: KEY_VERSION,
      digest: sha256(
        `v1\nPOST\n/__internal/hostname-replicas/v1\n${ISSUED_AT}\n3\n${createHash("sha256").update(BODY).digest("hex")}`,
      ),
    });
    expect(harness.fetch).toHaveBeenCalledExactlyOnceWith(AUDIENCE, {
      method: "POST",
      headers: {
        authorization: "Bearer google-oidc-token",
        "content-type": "application/json",
        "x-registry-body-signature": Buffer.from(SIGNATURE).toString("base64"),
        "x-registry-issued-at": String(ISSUED_AT),
        "x-registry-key-version": KEY_VERSION,
        "x-registry-publisher-epoch": "3",
      },
      body: BODY,
    });
  });

  it("throws a closed error for a non-success response without reading its body", async () => {
    const response = new Response(
      "private registry diagnostic: signed-body=do-not-leak",
      {
        status: 503,
      },
    );
    const text = vi.spyOn(response, "text");
    const harness = makeDeps(response);

    const delivery = publishRouterReplica(
      PAYLOAD,
      {
        registryOrigin: REGISTRY_ORIGIN,
        publisherEpoch: "3",
        keyVersion: KEY_VERSION,
      },
      harness.deps,
    );

    await expect(delivery).rejects.toMatchObject({
      name: "RouterReplicaPublishError",
      code: "registry-rejected",
      status: 503,
      message: "router replica publish failed: registry-rejected (503)",
    });
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown result", Response.json({ result: "revision-conflict" })],
    [
      "extra response field",
      Response.json({ result: "applied", signedBody: "do-not-leak" }),
    ],
    [
      "malformed JSON",
      new Response("signed-body=do-not-leak", { status: 200 }),
    ],
  ])(
    "throws a closed error for an invalid success body: %s",
    async (_label, response) => {
      const harness = makeDeps(response);

      await expect(
        publishRouterReplica(
          PAYLOAD,
          {
            registryOrigin: REGISTRY_ORIGIN,
            publisherEpoch: "3",
            keyVersion: KEY_VERSION,
          },
          harness.deps,
        ),
      ).rejects.toMatchObject({
        name: "RouterReplicaPublishError",
        code: "response-invalid",
        status: 200,
        message: "router replica publish failed: response-invalid (200)",
      });
    },
  );

  it.each([
    "identity-token-unavailable",
    "signing-unavailable",
    "registry-unavailable",
  ] as const)("sanitizes an injected %s failure", async (failureCode) => {
    const harness = makeDeps();
    const sensitive = new Error(
      "Bearer private-token; signature=private-signature; eventId=private-event",
    );

    if (failureCode === "identity-token-unavailable") {
      harness.getIdentityToken.mockRejectedValueOnce(sensitive);
    } else if (failureCode === "signing-unavailable") {
      harness.signDigest.mockRejectedValueOnce(sensitive);
    } else {
      harness.fetch.mockRejectedValueOnce(sensitive);
    }

    await expect(
      publishRouterReplica(
        PAYLOAD,
        {
          registryOrigin: REGISTRY_ORIGIN,
          publisherEpoch: "3",
          keyVersion: KEY_VERSION,
        },
        harness.deps,
      ),
    ).rejects.toMatchObject({
      name: "RouterReplicaPublishError",
      code: failureCode,
      message: `router replica publish failed: ${failureCode}`,
    });
  });

  it("treats an identical platform retry as an idempotent replay", async () => {
    const harness = makeDeps();
    harness.fetch
      .mockResolvedValueOnce(Response.json({ result: "applied" }))
      .mockResolvedValueOnce(Response.json({ result: "replay" }));
    const config = {
      registryOrigin: REGISTRY_ORIGIN,
      publisherEpoch: "3",
      keyVersion: KEY_VERSION,
    };

    await expect(
      publishRouterReplica(PAYLOAD, config, harness.deps),
    ).resolves.toEqual({
      result: "applied",
    });
    await expect(
      publishRouterReplica(PAYLOAD, config, harness.deps),
    ).resolves.toEqual({
      result: "replay",
    });

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.fetch.mock.calls[0]?.[1].body).toBe(BODY);
    expect(harness.fetch.mock.calls[1]?.[1].body).toBe(BODY);
  });

  it.each([
    [
      "non-origin registry URL",
      PAYLOAD,
      {
        registryOrigin: `${REGISTRY_ORIGIN}/nested`,
        publisherEpoch: "3",
        keyVersion: KEY_VERSION,
      },
      ISSUED_AT,
    ],
    [
      "non-workers.dev registry origin",
      PAYLOAD,
      {
        registryOrigin: "https://registry.example.com",
        publisherEpoch: "3",
        keyVersion: KEY_VERSION,
      },
      ISSUED_AT,
    ],
    [
      "non-canonical publisher epoch",
      PAYLOAD,
      {
        registryOrigin: REGISTRY_ORIGIN,
        publisherEpoch: "03",
        keyVersion: KEY_VERSION,
      },
      ISSUED_AT,
    ],
    [
      "invalid key-version resource",
      PAYLOAD,
      {
        registryOrigin: REGISTRY_ORIGIN,
        publisherEpoch: "3",
        keyVersion: `${KEY_VERSION}\nleak`,
      },
      ISSUED_AT,
    ],
    [
      "non-integral issued-at time",
      PAYLOAD,
      {
        registryOrigin: REGISTRY_ORIGIN,
        publisherEpoch: "3",
        keyVersion: KEY_VERSION,
      },
      ISSUED_AT + 0.5,
    ],
    [
      "body larger than 2 KiB",
      {
        ...PAYLOAD,
        desired: { ...PAYLOAD.desired, eventId: "x".repeat(2_048) },
      },
      {
        registryOrigin: REGISTRY_ORIGIN,
        publisherEpoch: "3",
        keyVersion: KEY_VERSION,
      },
      ISSUED_AT,
    ],
  ])(
    "rejects %s before acquiring credentials",
    async (_label, payload, config, issuedAt) => {
      const harness = makeDeps();
      harness.deps.now = () => issuedAt;

      await expect(
        publishRouterReplica(payload, config, harness.deps),
      ).rejects.toMatchObject({
        name: "RouterReplicaPublishError",
        code: "request-invalid",
        message: "router replica publish failed: request-invalid",
      });
      expect(harness.getIdentityToken).not.toHaveBeenCalled();
      expect(harness.signDigest).not.toHaveBeenCalled();
      expect(harness.fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps Admin, metadata, and KMS clients outside the publisher decision module", async () => {
    const sourcePath = fileURLToPath(
      new URL("../../router-publisher/src/publisher.ts", import.meta.url),
    );
    const source = await readFile(sourcePath, "utf8");

    expect(source).not.toMatch(/from\s+['"]firebase-admin(?:\/[^'"]*)?['"]/);
    expect(source).not.toMatch(/from\s+['"]google-auth-library['"]/);
    expect(source).not.toMatch(/from\s+['"]@google-cloud\/kms['"]/);
    expect(source).not.toMatch(/\bconsole\.(?:debug|info|log|warn|error)\b/);
  });
});
