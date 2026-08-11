import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface FakeMount {
  Type: "bind";
  Source: string;
  Destination: string;
  RW: boolean;
}

interface FakeContainer {
  Id: string;
  Config: { Image: string; Labels: Record<string, string>; WorkingDir: string; User: string };
  HostConfig: {
    NetworkMode: string;
    IpcMode: string;
    Privileged: boolean;
    RestartPolicy: { Name: string; MaximumRetryCount: number };
    ReadonlyRootfs: boolean;
    Memory: number;
    NanoCpus: number;
    PidsLimit: number;
    CapDrop: string[];
    SecurityOpt: string[];
    Tmpfs: Record<string, string>;
    Init: boolean;
  };
  State: { Running: boolean; Status: string };
  NetworkSettings: { Networks: Record<string, Record<string, never>> };
  Mounts: FakeMount[];
}

interface FakeState {
  calls: Array<{ argv: string[]; envKeys: string[] }>;
  containers: Record<string, FakeContainer>;
  behavior?: {
    failStop?: boolean;
    failKill?: boolean;
    failRemove?: boolean;
    malformedInspect?: boolean;
  };
}

function emptyState(): FakeState {
  return { calls: [], containers: {} };
}

const raw = process.argv.slice(2);
if (raw[0] !== "--state" || !raw[1]) {
  process.stderr.write("fake OCI engine requires --state PATH\n");
  process.exit(64);
}
const statePath = raw[1];
const argv = raw.slice(2);
const command = argv[0];
let state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8")) as FakeState
  : emptyState();

state.calls.push({ argv, envKeys: Object.keys(process.env).sort() });
persist();

switch (command) {
  case "version":
    process.stdout.write("27.4.1\n");
    break;
  case "create":
    createContainer(argv.slice(1));
    break;
  case "start":
    setRunning(argv.at(-1), true);
    break;
  case "inspect":
    inspectContainer(argv.at(-1));
    break;
  case "exec":
    execute(argv.slice(2));
    break;
  case "stop":
    if (state.behavior?.failStop) process.exit(71);
    setRunning(argv.at(-1), false);
    break;
  case "kill":
    if (state.behavior?.failKill) process.exit(72);
    setRunning(argv.at(-1), false);
    break;
  case "rm": {
    if (state.behavior?.failRemove) process.exit(73);
    const id = argv.at(-1);
    if (!id || !state.containers[id]) process.exit(44);
    delete state.containers[id];
    persist();
    break;
  }
  default:
    process.exit(64);
}

function persist(): void {
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
}

function createContainer(args: string[]): void {
  const valued = new Set([
    "--name",
    "--hostname",
    "--label",
    "--pull",
    "--network",
    "--ipc",
    "--restart",
    "--memory",
    "--cpus",
    "--pids-limit",
    "--cap-drop",
    "--security-opt",
    "--user",
    "--tmpfs",
    "--mount",
    "--workdir",
    "--entrypoint",
  ]);
  const labels: Record<string, string> = {};
  const mounts: FakeMount[] = [];
  let name = "";
  let network = "";
  let workingDir = "";
  let ipcMode = "";
  let restart = "";
  let memory = 0;
  let nanoCpus = 0;
  let pidsLimit = 0;
  let user = "";
  let tmpfs = "";
  let capDrop = "";
  const securityOpt: string[] = [];
  let readOnly = false;
  let init = false;
  let image = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--read-only") {
      readOnly = true;
      continue;
    }
    if (arg === "--init") {
      init = true;
      continue;
    }
    if (arg.startsWith("--")) {
      if (!valued.has(arg)) process.exit(64);
      const value = args[index + 1];
      if (value === undefined) process.exit(64);
      index += 1;
      if (arg === "--name") name = value;
      if (arg === "--network") network = value;
      if (arg === "--ipc") ipcMode = value;
      if (arg === "--restart") restart = value;
      if (arg === "--memory") memory = Number(value);
      if (arg === "--cpus") nanoCpus = Math.round(Number(value) * 1_000_000_000);
      if (arg === "--pids-limit") pidsLimit = Number(value);
      if (arg === "--user") user = value;
      if (arg === "--tmpfs") tmpfs = value;
      if (arg === "--cap-drop") capDrop = value;
      if (arg === "--security-opt") securityOpt.push(value);
      if (arg === "--workdir") workingDir = value;
      if (arg === "--label") {
        const separator = value.indexOf("=");
        labels[value.slice(0, separator)] = value.slice(separator + 1);
      }
      if (arg === "--mount") mounts.push(parseMount(value));
      continue;
    }
    image = arg;
    break;
  }
  if (
    !name || !network || !workingDir || !image || !ipcMode || restart !== "no" || !memory || !nanoCpus || !pidsLimit || !user
    || !tmpfs || !capDrop || securityOpt.length !== 2 || !readOnly || !init || mounts.length !== 2
  ) process.exit(64);
  const id = createHash("sha256").update(name).digest("hex");
  if (state.containers[id]) process.exit(65);
  state.containers[id] = {
    Id: id,
    Config: { Image: image, Labels: labels, WorkingDir: workingDir, User: user },
    HostConfig: {
      NetworkMode: network,
      IpcMode: ipcMode,
      Privileged: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      ReadonlyRootfs: readOnly,
      Memory: memory,
      NanoCpus: nanoCpus,
      PidsLimit: pidsLimit,
      CapDrop: [capDrop],
      SecurityOpt: securityOpt,
      Tmpfs: { [tmpfs.slice(0, tmpfs.indexOf(":"))]: tmpfs.slice(tmpfs.indexOf(":") + 1) },
      Init: init,
    },
    State: { Running: false, Status: "created" },
    NetworkSettings: { Networks: { [network]: {} } },
    Mounts: mounts,
  };
  persist();
  process.stdout.write(`${id}\n`);
}

function parseMount(value: string): FakeMount {
  const fields = Object.fromEntries(value.split(",").filter((item) => item.includes("=")).map((item) => {
    const index = item.indexOf("=");
    return [item.slice(0, index), item.slice(index + 1)];
  }));
  return {
    Type: "bind",
    Source: fields.src,
    Destination: fields.dst,
    RW: !value.split(",").includes("readonly"),
  };
}

function setRunning(id: string | undefined, running: boolean): void {
  if (!id || !state.containers[id]) process.exit(44);
  state.containers[id].State = { Running: running, Status: running ? "running" : "exited" };
  persist();
  process.stdout.write(`${id}\n`);
}

function inspectContainer(id: string | undefined): void {
  if (state.behavior?.malformedInspect) {
    process.stdout.write("not-json\n");
    return;
  }
  if (!id || !state.containers[id]) process.exit(44);
  process.stdout.write(`${JSON.stringify([state.containers[id]])}\n`);
}

function execute(commandArgs: string[]): void {
  if (commandArgs[0] === "emit-bytes") {
    const count = Number(commandArgs[1]);
    process.stdout.write("x".repeat(Number.isFinite(count) ? count : 0));
    return;
  }
  if (commandArgs[0] === "hang") {
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1_000);
    return;
  }
  if (commandArgs[0] === "fail") {
    process.stderr.write("fake failure output\n");
    process.exit(Number(commandArgs[1] ?? 1));
  }
  process.stdout.write("ok\n");
}
