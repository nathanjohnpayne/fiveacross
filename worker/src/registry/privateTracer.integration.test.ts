// @vitest-environment node
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  sign,
  type KeyObject,
} from "node:crypto";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { Log, LogLevel, Miniflare } from "miniflare";
import {
  publishRouterReplica,
  type RouterReplicaDesired,
} from "../../../router-publisher/src/publisher";

const HOST = "r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app";
const REGISTRY_ORIGIN = "https://private-tracer-registry.example.workers.dev";
const AUDIENCE = `${REGISTRY_ORIGIN}/__internal/hostname-replicas/v1`;
const SUBJECT = "109876543210987654321";
const PUBLISHER_EPOCH = "1";
const KEY_VERSION =
  "projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher/cryptoKeyVersions/1";
const OIDC_KID = "synthetic-private-tracer";
const NOW = Date.parse("2026-08-19T12:35:00.000Z");
const SHA256_DIGEST_INFO_PREFIX = Buffer.from(
  "3031300d060960864801650304020105000420",
  "hex",
);
const instances: Miniflare[] = [];

const payload: RouterReplicaDesired = {
  schemaVersion: 1,
  revision: "1",
  host: HOST,
  desired: {
    kind: "route",
    eventId: "private-tracer-event",
    status: "active",
    slug: "r2-abcdefghijklmnopqrstuvwxyz",
    edition: "fiveacross",
    pathNamespace: null,
  },
  updatedAt: new Date(NOW).toISOString(),
};

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function oidcToken(privateKey: KeyObject): string {
  const issuedAt = Math.floor(NOW / 1_000);
  const header = base64Url(
    JSON.stringify({ alg: "RS256", kid: OIDC_KID, typ: "JWT" }),
  );
  const claims = base64Url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: AUDIENCE,
      sub: SUBJECT,
      iat: issuedAt - 1,
      exp: issuedAt + 300,
    }),
  );
  const input = `${header}.${claims}`;
  return `${input}.${base64Url(sign("RSA-SHA256", Buffer.from(input), privateKey))}`;
}

function kmsSignDigest(privateKey: KeyObject, digest: Uint8Array): Uint8Array {
  return privateEncrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.concat([SHA256_DIGEST_INFO_PREFIX, digest]),
  );
}

async function bundled(contents: string, sourcefile: string): Promise<string> {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), sourcefile },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers"],
  });
  return result.outputFiles[0].text;
}

describe("private registry tracer", () => {
  it("delivers publisher-exact bytes through authenticated sync and the named lookup binding", async () => {
    const publisherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oidcKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publisherPem = publisherKeys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const publisherFingerprint = createHash("sha256")
      .update(publisherKeys.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");
    const oidcJwk = oidcKeys.publicKey.export({ format: "jwk" });

    const registryBundle = await bundled(
      `
        import { HostRegistryObject, RegistryLookupEntrypoint } from './worker/src/registry/registryWorker.ts';
        import { handleRegistryFetch } from './worker/src/registry/service.ts';
        export { HostRegistryObject, RegistryLookupEntrypoint };
        const oidcJwk = ${JSON.stringify(oidcJwk)};
        const verificationRecords = [${JSON.stringify({
          role: "publisher",
          subject: SUBJECT,
          epochOrSlot: PUBLISHER_EPOCH,
          keyVersion: KEY_VERSION,
          algorithm: "RSA_SIGN_PKCS1_2048_SHA256",
          pem: publisherPem,
          spkiSha256: publisherFingerprint,
        })}];
        let oidcKey;
        export default {
          async fetch(request, env) {
            return handleRegistryFetch(
              request,
              { audience: ${JSON.stringify(AUDIENCE)}, verificationRecords },
              {
                now: () => ${NOW},
                jwks: {
                  async resolve(kid) {
                    if (kid !== ${JSON.stringify(OIDC_KID)}) return null;
                    oidcKey ??= await crypto.subtle.importKey(
                      'jwk', oidcJwk,
                      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                      false, ['verify'],
                    );
                    return oidcKey;
                  },
                },
                hostRegistry: env.HOST_REGISTRY,
                rateLimiter: { async limit() { return { success: true }; } },
                randomId: () => 'private-tracer-id',
              },
            );
          },
        };
      `,
      "private-tracer-registry.ts",
    );
    const harnessBundle = await bundled(
      `
        import { lookupSyntheticHost } from './worker/src/registry/registryHarnessCore.ts';
        export default {
          async fetch(request, env) {
            const body = await request.json();
            return Response.json(await lookupSyntheticHost(body.host, env.REGISTRY));
          },
        };
      `,
      "private-tracer-harness.ts",
    );
    const instance = new Miniflare({
      log: new Log(LogLevel.NONE),
      workers: [
        {
          name: "private-tracer-harness",
          compatibilityDate: "2026-07-30",
          modules: [
            { type: "ESModule", path: "harness.mjs", contents: harnessBundle },
          ],
          serviceBindings: {
            REGISTRY: {
              name: "private-tracer-registry",
              entrypoint: "RegistryLookupEntrypoint",
            },
          },
        },
        {
          name: "private-tracer-registry",
          compatibilityDate: "2026-07-30",
          modules: [
            {
              type: "ESModule",
              path: "registry.mjs",
              contents: registryBundle,
            },
          ],
          durableObjects: {
            HOST_REGISTRY: {
              className: "HostRegistryObject",
              scriptName: "private-tracer-registry",
              useSQLite: true,
              unsafeUniqueKey: "event-router-registry-private-tracer-v1",
            },
          },
        },
      ],
    });
    instances.push(instance);
    const registry = await instance.getWorker("private-tracer-registry");
    let exactBody = "";

    const result = await publishRouterReplica(
      payload,
      {
        registryOrigin: REGISTRY_ORIGIN,
        publisherEpoch: PUBLISHER_EPOCH,
        keyVersion: KEY_VERSION,
      },
      {
        now: () => NOW,
        getIdentityToken: async (audience) => {
          expect(audience).toBe(AUDIENCE);
          return oidcToken(oidcKeys.privateKey);
        },
        signDigest: async ({ keyVersion, digest }) => {
          expect(keyVersion).toBe(KEY_VERSION);
          return kmsSignDigest(publisherKeys.privateKey, digest);
        },
        fetch: async (url, init) => {
          expect(url).toBe(AUDIENCE);
          exactBody = String(init.body);
          const requestHeaders = {
            ...(init.headers as Record<string, string>),
            "cf-connecting-ip": "192.0.2.70",
          };
          const response = await registry.fetch(url, {
            method: init.method,
            headers: requestHeaders,
            body: exactBody,
          });
          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            responseHeaders[name] = value;
          });
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            headers: responseHeaders,
          });
        },
      },
    );

    expect(result).toEqual({ result: "applied" });
    expect(exactBody).toBe(JSON.stringify(payload));
    const lookup = await instance.dispatchFetch(
      "https://private-tracer.invalid/lookup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: HOST }),
      },
    );
    expect(lookup.status).toBe(200);
    await expect(lookup.json()).resolves.toMatchObject({
      kind: "committed",
      revision: "1",
      desired: { kind: "route", eventId: "private-tracer-event" },
    });
  }, 30_000);
});
