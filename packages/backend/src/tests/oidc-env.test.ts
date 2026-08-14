import { afterEach, describe, expect, test } from "bun:test";
import { getEnv, resetEnvCache } from "../utils/env";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
  }
}

describe("OIDC env configuration", () => {
  afterEach(() => resetEnvCache());

  test("SSO disabled by default (no issuer)", () => {
    withEnv({ OIDC_ISSUER_URL: undefined }, () => {
      const env = getEnv();
      expect(env.OIDC_ISSUER_URL).toBe("");
      expect(env.OIDC_SCOPE).toBe("openid email profile");
      expect(env.OIDC_ALLOWED_DOMAINS).toEqual([]);
      expect(env.OIDC_AUTO_PROVISION).toBe(true);
      expect(env.OIDC_PROVIDER_NAME).toBe("");
    });
  });

  test("issuer + client id + secret enables SSO and strips trailing slash", () => {
    withEnv(
      {
        OIDC_ISSUER_URL: "https://auth.example.com/realms/main/",
        OIDC_CLIENT_ID: "inkvoice",
        OIDC_CLIENT_SECRET: "s3cret",
      },
      () => {
        const env = getEnv();
        expect(env.OIDC_ISSUER_URL).toBe("https://auth.example.com/realms/main");
      },
    );
  });

  test("https issuer without client id or secret is FATAL", () => {
    withEnv({ OIDC_ISSUER_URL: "https://auth.example.com", OIDC_CLIENT_ID: "inkvoice" }, () => {
      expect(() => getEnv()).toThrow();
    });
  });

  test("http issuer is rejected", () => {
    withEnv(
      {
        OIDC_ISSUER_URL: "http://auth.example.com",
        OIDC_CLIENT_ID: "inkvoice",
        OIDC_CLIENT_SECRET: "s3cret",
      },
      () => expect(() => getEnv()).toThrow(),
    );
  });

  test("issuer with embedded credentials is rejected", () => {
    withEnv(
      {
        OIDC_ISSUER_URL: "https://user:pass@auth.example.com",
        OIDC_CLIENT_ID: "inkvoice",
        OIDC_CLIENT_SECRET: "s3cret",
      },
      () => expect(() => getEnv()).toThrow(),
    );
  });

  test("malformed issuer is rejected", () => {
    withEnv(
      {
        OIDC_ISSUER_URL: "not a url",
        OIDC_CLIENT_ID: "inkvoice",
        OIDC_CLIENT_SECRET: "s3cret",
      },
      () => expect(() => getEnv()).toThrow(),
    );
  });

  test("allowed domains are trimmed and lowercased; auto-provision flag parsed", () => {
    withEnv(
      {
        OIDC_ISSUER_URL: "https://auth.example.com",
        OIDC_CLIENT_ID: "inkvoice",
        OIDC_CLIENT_SECRET: "s3cret",
        OIDC_ALLOWED_DOMAINS: " Example.COM , other.org ",
        OIDC_AUTO_PROVISION: "false",
        OIDC_PROVIDER_NAME: "Google Workspace",
      },
      () => {
        const env = getEnv();
        expect(env.OIDC_ALLOWED_DOMAINS).toEqual(["example.com", "other.org"]);
        expect(env.OIDC_AUTO_PROVISION).toBe(false);
        expect(env.OIDC_PROVIDER_NAME).toBe("Google Workspace");
      },
    );
  });
});
