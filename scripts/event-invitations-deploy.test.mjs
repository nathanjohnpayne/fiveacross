// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFirebaseDeployRequest } from "./validate-firebase-deploy-filters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function classify(args) {
  return classifyFirebaseDeployRequest(["fiveacross", ...args], {
    defaultConfigPath: resolve(repoRoot, "firebase.json"),
  });
}

describe("event-invitation deploy scope", () => {
  it.each([
    { args: [] },
    { args: ["--only", "functions"] },
    { args: ["--only", "functions:default"] },
  ])(
    "keeps all three services strict for a full Functions release ($args)",
    async ({ args }) => {
      const result = await classify(args);

      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: true,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: "mint,redeem,revoke",
      });
    },
  );

  it.each([
    ["functions:mintEventInvitation", "mint"],
    ["functions:default:redeemEventInvitation", "redeem"],
    ["functions:revokeEventInvitation", "revoke"],
    [
      "functions:mintEventInvitation,functions:revokeEventInvitation",
      "mint,revoke",
    ],
  ])(
    "keeps only explicitly selected services strict for %s",
    async (only, strict) => {
      const result = await classify(["--only", only]);

      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: true,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: strict,
      });
    },
  );

  it.each([
    "functions:someGroup,functions:redeemEventInvitation",
    "functions:redeemEventInvitation,functions:someGroup",
  ])(
    "keeps an exact endpoint strict alongside an unfamiliar selector (%s)",
    async (only) => {
      const result = await classify(["--only", only]);

      expect(result).toMatchObject({
        eventInvitationsInvokerSelected: true,
        eventInvitationsInvokerConservative: false,
        eventInvitationsStrictServices: "redeem",
      });
    },
  );

  it("treats an unfamiliar Functions selector as an allow-missing probe", async () => {
    const result = await classify(["--only", "functions:someGroup"]);

    expect(result).toMatchObject({
      eventInvitationsInvokerSelected: true,
      eventInvitationsInvokerConservative: true,
      eventInvitationsStrictServices: "",
    });
  });

  it("does not inspect invitation services for an unrelated exact endpoint", async () => {
    const result = await classify(["--only", "functions:emailUnsubscribe"]);

    expect(result).toMatchObject({
      eventInvitationsInvokerSelected: false,
      eventInvitationsInvokerConservative: false,
      eventInvitationsStrictServices: "",
    });
  });

  it("honors only the top-level Functions exclusion", async () => {
    const excluded = await classify(["--except", "functions"]);
    expect(excluded.eventInvitationsInvokerSelected).toBe(false);

    const endpointQualifiedNoop = await classify([
      "--except",
      "functions:mintEventInvitation",
    ]);
    expect(endpointQualifiedNoop).toMatchObject({
      eventInvitationsInvokerSelected: true,
      eventInvitationsInvokerConservative: false,
      eventInvitationsStrictServices: "mint,redeem,revoke",
    });
  });
});
