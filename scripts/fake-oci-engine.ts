import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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
    missingImageDigest?: boolean;
    wrongImageDigest?: boolean;
    missingImageLabels?: boolean;
    wrongImageLabels?: boolean;
    missingAtomicVersion?: boolean;
    wrongAtomicVersion?: boolean;
    hangAtomicVersion?: boolean;
    retainAtomicVersionPipe?: boolean;
    createNameCollision?: boolean;
    hangAfterProbeCreate?: boolean;
    wrongInternalNetwork?: boolean;
  };
}

const REVIEWED_IMAGE_LABELS = Object.freeze({
  "io.valkyrie.atomic.version": "0.9.12",
  "io.valkyrie.git.version": "2.50.1",
  "io.valkyrie.git.source": "https://www.kernel.org/pub/software/scm/git/git-2.50.1.tar.xz",
  "io.valkyrie.git.source.sha256": "7e3e6c36decbd8f1eedd14d42db6674be03671c2204864befa2a41756c5c8fc4",
});

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
  case "image":
    inspectImage(argv.slice(1));
    break;
  case "network": {
    if (argv[1] !== "inspect") process.exit(64);
    const name = argv.at(-1);
    process.stdout.write(`${JSON.stringify({
      Name: name,
      Internal: state.behavior?.wrongInternalNetwork ? false : true,
      Ingress: false,
      Driver: "bridge",
      Scope: "local",
    })}\n`);
    break;
  }
  case "create":
    createContainer(argv.slice(1));
    break;
  case "start":
    setRunning(argv.at(-1), true);
    break;
  case "inspect":
    inspectContainer(argv.at(-1));
    break;
  case "ps":
    listContainers(argv.slice(1));
    break;
  case "exec":
    execute(argv.slice(1));
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
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, statePath);
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
    || !tmpfs || !capDrop || securityOpt.length !== 2 || !readOnly || !init
  ) process.exit(64);
  const runnerProbe = labels["valkyrie.kind"] === "atomic-runner-preflight";
  if (mounts.length !== (runnerProbe ? 0 : 2)) process.exit(64);
  const id = createHash("sha256").update(name).digest("hex");
  if (state.containers[id]) process.exit(65);
  const container: FakeContainer = {
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
  if (state.behavior?.createNameCollision && runnerProbe) {
    container.Config.Labels = { "unrelated.owner": "true" };
    state.containers[id] = container;
    persist();
    process.exit(65);
  }
  state.containers[id] = container;
  persist();
  if (state.behavior?.hangAfterProbeCreate && runnerProbe) {
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1_000);
    return;
  }
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

function inspectImage(args: string[]): void {
  if (args[0] !== "inspect" || args[1] !== "--format" || !args[2] || !args[3] || args.length !== 4) {
    process.exit(64);
  }
  const image = args[3];
  const repoDigests = state.behavior?.missingImageDigest
    ? []
    : state.behavior?.wrongImageDigest
      ? [`fixture.invalid/wrong-runner@sha256:${"f".repeat(64)}`]
      : [image];
  const labels = state.behavior?.missingImageLabels
    ? null
    : {
      ...REVIEWED_IMAGE_LABELS,
      ...(state.behavior?.wrongImageLabels ? { "io.valkyrie.atomic.version": "9.9.9" } : {}),
    };
  process.stdout.write(`${JSON.stringify({ repoDigests, labels })}\n`);
}

function listContainers(args: string[]): void {
  let index = 0;
  const noTrunc = args[index] === "--no-trunc";
  if (noTrunc) index += 1;
  if (args[index++] !== "--all") process.exit(64);
  const filters: Array<[string, string]> = [];
  while (args[index] === "--filter") {
    index += 1;
    const value = args[index++];
    if (!value?.startsWith("label=") || !value.includes("=")) process.exit(64);
    const label = value.slice("label=".length);
    const separator = label.indexOf("=");
    filters.push([label.slice(0, separator), label.slice(separator + 1)]);
  }
  if (args[index++] !== "--format" || args[index++] !== "{{.ID}}" || index !== args.length) process.exit(64);
  for (const container of Object.values(state.containers)) {
    if (filters.every(([name, value]) => container.Config.Labels[name] === value)) {
      process.stdout.write(`${noTrunc ? container.Id : container.Id.slice(0, 12)}\n`);
    }
  }
}

function execute(args: string[]): void {
  let index = 0;
  let interactive = false;
  let workingDirectory: string | undefined;
  const containerEnvironment: Record<string, string> = {};
  while (args[index]?.startsWith("-")) {
    const option = args[index++];
    if (option === "-i") {
      interactive = true;
      continue;
    }
    if (option === "--workdir") {
      workingDirectory = args[index++];
      if (!workingDirectory) process.exit(64);
      continue;
    }
    if (option === "--env") {
      const entry = args[index++];
      const separator = entry?.indexOf("=") ?? -1;
      if (!entry || separator < 1) process.exit(64);
      containerEnvironment[entry.slice(0, separator)] = entry.slice(separator + 1);
      continue;
    }
    process.exit(64);
  }
  const containerId = args[index++];
  if (!containerId || !state.containers[containerId]?.State.Running) process.exit(44);
  const commandArgs = args.slice(index);
  if (commandArgs[0]?.endsWith("/atomic") && commandArgs[1] === "--version") {
    if (state.behavior?.retainAtomicVersionPipe) {
      spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 3000)"], {
        stdio: ["ignore", process.stdout, process.stderr],
      });
      process.on("SIGTERM", () => undefined);
      setInterval(() => undefined, 1_000);
      return;
    }
    if (state.behavior?.hangAtomicVersion) {
      process.on("SIGTERM", () => undefined);
      setInterval(() => undefined, 1_000);
      return;
    }
    if (state.behavior?.missingAtomicVersion) return;
    process.stdout.write(`${state.behavior?.wrongAtomicVersion ? "9.9.9" : "0.9.12"}\n`);
    return;
  }
  if (interactive && commandArgs[0]?.endsWith("/atomic") && commandArgs[1] === "--mode" && commandArgs[2] === "rpc") {
    runAtomicRpc(commandArgs, workingDirectory, containerEnvironment);
    return;
  }
  if (
    (JSON.stringify(commandArgs) === JSON.stringify(["/bin/mkdir", "-m", "700", "/workspace/.atomic-agent"]))
    || (commandArgs[0] === "/usr/bin/install" && commandArgs[1] === "-m" && commandArgs[2] === "600"
      && ["models.json", "settings.json"].some((name) => JSON.stringify(commandArgs.slice(3)) === JSON.stringify([
        `/run-context/atomic-agent/${name}`, `/workspace/.atomic-agent/${name}`,
      ])))
  ) {
    process.stdout.write("ok\n");
    return;
  }
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

function runAtomicRpc(
  commandArgs: string[],
  workingDirectory: string | undefined,
  containerEnvironment: Record<string, string>,
): void {
  if (workingDirectory !== "/workspace/worktree") process.exit(64);
  const requiredEnvironment = {
    HOME: "/workspace/.atomic-home",
    XDG_CONFIG_HOME: "/workspace/.atomic-home/config",
    XDG_DATA_HOME: "/workspace/.atomic-home/data",
    XDG_CACHE_HOME: "/workspace/.atomic-home/cache",
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp",
  };
  const acceptedEnvironment = { ...requiredEnvironment } as Record<string, string>;
  if (containerEnvironment.ATOMIC_CODING_AGENT_DIR !== undefined) {
    if (containerEnvironment.ATOMIC_CODING_AGENT_DIR !== "/workspace/.atomic-agent") process.exit(64);
    acceptedEnvironment.ATOMIC_CODING_AGENT_DIR = "/workspace/.atomic-agent";
  }
  if (JSON.stringify(containerEnvironment) !== JSON.stringify(acceptedEnvironment)) process.exit(64);
  const sessionIndex = commandArgs.indexOf("--session-dir");
  const nameIndex = commandArgs.indexOf("--name");
  const extensionIndex = commandArgs.indexOf("-e");
  if (
    sessionIndex < 0 || commandArgs[sessionIndex + 1] !== "/workspace/.atomic-sessions"
    || nameIndex < 0 || !commandArgs[nameIndex + 1]
    || extensionIndex < 0 || commandArgs[extensionIndex + 1] !== "/run-context/atomic-package"
    || !commandArgs.includes("--approve")
    || commandArgs.includes("--no-approve")
  ) process.exit(64);

  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(line) as Record<string, unknown>;
      } catch {
        process.exit(65);
        return;
      }
      const id = request.id;
      const type = request.type;
      if (typeof id !== "string" || typeof type !== "string") process.exit(65);
      if (type === "prompt" && request.message === "__fake:transport-overflow__") {
        process.stdout.write("x".repeat(32 * 1024));
        continue;
      }
      if (type === "prompt") {
        process.stdout.write(`${JSON.stringify({
          type: "entry_appended",
          entry: { id: "oci-native-entry", content: `async:${String(request.message ?? "")}` },
        })}\n`);
      }
      const data = type === "get_state"
        ? { sessionId: `oci-${commandArgs[nameIndex + 1]}`, isStreaming: false }
        : type === "prompt"
          ? { echoed: request.message }
          : {};
      process.stdout.write(`${JSON.stringify({ type: "response", id, command: type, success: true, data })}\n`);
    }
  });
  process.stdin.resume();
}
