import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hasValidBearerAuthorization,
  isLoopbackHost,
  loadControlPlaneAuth,
} from "../apps/control-plane/src/auth.ts";

const token = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";

test("loads a valid bearer token from exactly one configured source", () => {
  assert.equal(loadControlPlaneAuth({ CONTROL_PLANE_AUTH_TOKEN: token })?.token, token);
  assert.equal(loadControlPlaneAuth({}), undefined);
  assert.throws(
    () => loadControlPlaneAuth({
      CONTROL_PLANE_AUTH_TOKEN: token,
      CONTROL_PLANE_AUTH_TOKEN_FILE: "/unused/token",
    }),
    /only one/,
  );
  assert.throws(() => loadControlPlaneAuth({ CONTROL_PLANE_AUTH_TOKEN: "short" }), /at least 32/);
  assert.throws(() => loadControlPlaneAuth({ CONTROL_PLANE_AUTH_TOKEN: `${token} embedded` }), /without whitespace/);
});

test("token files must be private regular non-symlink files", () => {
  const root = mkdtempSync(join(tmpdir(), "control-plane-auth-"));
  const secure = join(root, "secure.token");
  const loose = join(root, "loose.token");
  const link = join(root, "link.token");
  try {
    writeFileSync(secure, `${token}\n`, { mode: 0o600 });
    assert.equal(loadControlPlaneAuth({ CONTROL_PLANE_AUTH_TOKEN_FILE: secure })?.token, token);

    writeFileSync(loose, `${token}\n`, { mode: 0o644 });
    if (process.platform !== "win32") {
      chmodSync(loose, 0o644);
      assert.throws(
        () => loadControlPlaneAuth({ CONTROL_PLANE_AUTH_TOKEN_FILE: loose }),
        /mode 0600/,
      );
      chmodSync(loose, 0o400);
      assert.throws(() => loadControlPlaneAuth({ CONTROL_PLANE_AUTH_TOKEN_FILE: loose }), /mode 0600/);
    }

    symlinkSync(secure, link);
    assert.throws(
      () => loadControlPlaneAuth({ CONTROL_PLANE_AUTH_TOKEN_FILE: link }),
      /regular, non-symlink/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bearer comparison is exact and rejects malformed authorization", () => {
  assert.equal(hasValidBearerAuthorization(`Bearer ${token}`, token), true);
  assert.equal(hasValidBearerAuthorization(`bearer ${token}`, token), true);
  assert.equal(hasValidBearerAuthorization(`Basic ${token}`, token), false);
  assert.equal(hasValidBearerAuthorization(`Bearer ${token} trailing`, token), false);
  assert.equal(hasValidBearerAuthorization(`Bearer ${token}x`, token), false);
  assert.equal(hasValidBearerAuthorization(undefined, token), false);
});

test("loopback host recognition rejects wildcard and LAN bindings", () => {
  for (const host of ["localhost", "127.0.0.1", "127.12.34.56", "::1", "[::1]", "0:0:0:0:0:0:0:1"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.5", "control-plane.local", "localhost.example.com"]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
