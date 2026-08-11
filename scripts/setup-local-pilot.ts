import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const tokenPath = resolve(process.env.CONTROL_PLANE_AUTH_TOKEN_FILE ?? "data/auth/control-plane.token");
mkdirSync(dirname(tokenPath), { recursive: true });

let existingToken: ReturnType<typeof lstatSync> | undefined;
try {
  existingToken = lstatSync(tokenPath);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

if (!existingToken) {
  writeFileSync(tokenPath, `${randomBytes(32).toString("base64url")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(`Created a local control-plane bearer token at ${tokenPath}`);
} else {
  if (existingToken.isSymbolicLink() || !existingToken.isFile()) {
    throw new Error("Refusing to use a non-regular or symlinked CONTROL_PLANE_AUTH_TOKEN_FILE");
  }
  chmodSync(tokenPath, 0o600);
  console.log(`Kept the existing local control-plane bearer token at ${tokenPath}`);
}

const atomic = resolve("data/runtime/atomic/node_modules/.bin/atomic");
if (existsSync(atomic)) console.log(`Pinned Atomic runtime is installed at ${atomic}`);
else console.log("Atomic is not installed yet. Run: npm run setup:atomic");

console.log("Next: ./bin/project-os-pilot-server");
console.log("Then, in another terminal: npm run setup:hermes");
