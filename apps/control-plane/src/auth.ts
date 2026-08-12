import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

const MINIMUM_TOKEN_CHARACTERS = 32;
const MAXIMUM_TOKEN_BYTES = 4_096;

export interface ControlPlaneAuth {
  token: string;
  source: "environment" | "file";
}

function validateToken(raw: string, source: string): string {
  if (Buffer.byteLength(raw, "utf8") > MAXIMUM_TOKEN_BYTES) {
    throw new Error(`${source} exceeds the ${MAXIMUM_TOKEN_BYTES}-byte limit`);
  }
  const token = raw.trim();
  if (token.length < MINIMUM_TOKEN_CHARACTERS) {
    throw new Error(`${source} must contain at least ${MINIMUM_TOKEN_CHARACTERS} characters`);
  }
  if (/\s|[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error(`${source} must be a single bearer-token value without whitespace or control characters`);
  }
  return token;
}

export function readPrivateSecretFile(path: string, label = "SECRET_FILE", minimumCharacters = 16): string {
  const absolutePath = resolve(path);
  const linkStatus = lstatSync(absolutePath);
  if (linkStatus.isSymbolicLink() || !linkStatus.isFile()) {
    throw new Error(`${label} must name a regular, non-symlink file`);
  }
  if (process.platform !== "win32" && (linkStatus.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must use mode 0600`);
  }
  if (linkStatus.size > MAXIMUM_TOKEN_BYTES) {
    throw new Error(`${label} exceeds the ${MAXIMUM_TOKEN_BYTES}-byte limit`);
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStatus = fstatSync(descriptor);
    if (!openedStatus.isFile()) {
      throw new Error(`${label} must name a regular file`);
    }
    if (process.platform !== "win32" && (openedStatus.mode & 0o777) !== 0o600) {
      throw new Error(`${label} must use mode 0600`);
    }
    if (openedStatus.size > MAXIMUM_TOKEN_BYTES) {
      throw new Error(`${label} exceeds the ${MAXIMUM_TOKEN_BYTES}-byte limit`);
    }
    const value = readFileSync(descriptor, "utf8").trim();
    if (value.length < minimumCharacters || /\s|[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`${label} must contain one non-whitespace secret of at least ${minimumCharacters} characters`);
    }
    return value;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadControlPlaneAuth(
  environment: NodeJS.ProcessEnv = process.env,
): ControlPlaneAuth | undefined {
  const inlineToken = environment.CONTROL_PLANE_AUTH_TOKEN;
  const tokenFile = environment.CONTROL_PLANE_AUTH_TOKEN_FILE?.trim();
  if (inlineToken !== undefined && inlineToken.trim() !== "" && tokenFile) {
    throw new Error("Set only one of CONTROL_PLANE_AUTH_TOKEN or CONTROL_PLANE_AUTH_TOKEN_FILE");
  }
  if (inlineToken !== undefined && inlineToken.trim() !== "") {
    return { token: validateToken(inlineToken, "CONTROL_PLANE_AUTH_TOKEN"), source: "environment" };
  }
  if (tokenFile) {
    return { token: validateToken(readPrivateSecretFile(tokenFile, "CONTROL_PLANE_AUTH_TOKEN_FILE", MINIMUM_TOKEN_CHARACTERS), "CONTROL_PLANE_AUTH_TOKEN_FILE"), source: "file" };
  }
  return undefined;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function hasValidBearerAuthorization(header: string | undefined, expectedToken: string): boolean {
  if (!header) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(expectedToken));
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  return false;
}

/**
 * Bearer-bearing local pilot clients must never accept an arbitrary URL. Return
 * a normalized origin only after proving the endpoint is plain HTTP loopback
 * with no userinfo, path, query, or fragment.
 */
export function validateLoopbackControlPlaneApi(value: string): string {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("CONTROL_PLANE_API must be a non-empty, trimmed loopback HTTP origin");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CONTROL_PLANE_API must be a valid loopback HTTP origin");
  }
  if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname)
    || parsed.username || parsed.password || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.search || parsed.hash) {
    throw new Error("CONTROL_PLANE_API must be an http:// loopback origin without userinfo, path, query, or fragment");
  }
  return parsed.origin;
}
