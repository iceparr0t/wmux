import assert from "node:assert/strict";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sourceRoot = path.resolve(".");
const sourcePolicy = path.join(sourceRoot, "deploy/docker/docker-staging-policy.mjs");
const sourceSmoke = path.join(sourceRoot, "deploy/docker/docker-staging-smoke.mjs");
const approvedWorktreeRoot = "/mnt/storage/sw_projects/.worktrees/wmux";
const privateHost = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal
  && (/^10\./.test(entry.address) || /^192\.168\./.test(entry.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address) || /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./.test(entry.address)))?.address ?? "100.64.0.1";
const containerId = "a".repeat(64);
const networkId = "b".repeat(64);
const imageId = `sha256:${"c".repeat(64)}`;

const executable = (filePath: string, source: string) => fs.writeFileSync(filePath, source, { mode: 0o755 });
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const metadata = (filePath: string) => Object.fromEntries(fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => {
  const separator = line.indexOf("=");
  return [line.slice(0, separator), line.slice(separator + 1)];
}));

type Fixture = ReturnType<typeof makeFixture>;

const removeFixture = (fixture: Fixture) => {
  try {
    const identity = path.join(fixture.runtime, fixture.project, "identity.env");
    if (fs.existsSync(identity)) {
      const values = metadata(identity);
      if (fs.existsSync(values.WMUX_ISOLATED_REPOSITORY)) {
        spawnSync("git", ["--git-dir", values.WMUX_ISOLATED_REPOSITORY, "worktree", "remove", "--force", values.WMUX_WORKTREE]);
      }
      fs.rmSync(values.WMUX_WORKTREE, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
};

function makeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-staging-worktree-"));
  fs.chmodSync(directory, 0o700);
  const repository = path.join(directory, "source");
  const runtime = path.join(directory, "runtime");
  const stateHome = path.join(directory, "state-home");
  const state = path.join(directory, "docker-state");
  const bin = path.join(directory, "bin");
  const log = path.join(directory, "commands.log");
  const project = `wmux-staging-test${path.basename(directory).replace(/[^a-z0-9]/gi, "").toLowerCase()}`.slice(0, 62);
  fs.mkdirSync(repository, { mode: 0o700 });
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(bin, { mode: 0o700 });
  for (const relative of [
    "scripts/wmux-docker-staging", "deploy/docker/docker-bind-host.mjs", "deploy/docker/docker-staging-policy.mjs",
    "deploy/docker/docker-staging-smoke.mjs", "deploy/docker/docker-compose.staging.yml", "deploy/docker/Dockerfile",
  ]) {
    const target = path.join(repository, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relative), target);
  }
  fs.chmodSync(path.join(repository, "scripts/wmux-docker-staging"), 0o755);
  fs.writeFileSync(path.join(repository, "package.json"), '{"name":"candidate","scripts":{"test:e2e:browser:chromium":"true"}}\n');
  fs.writeFileSync(path.join(repository, "package-lock.json"), '{"name":"candidate","lockfileVersion":3,"requires":true,"packages":{"":{"name":"candidate"}}}\n');
  fs.writeFileSync(path.join(repository, "playwright.browser.config.ts"), "export default {};\n");
  fs.writeFileSync(path.join(repository, ".gitattributes"), "*.sh text eol=lf\nscripts/** text eol=lf\n");
  fs.symlinkSync("package.json", path.join(repository, "fixture-link"));
  git(repository, "init", "-q");
  git(repository, "-c", "user.name=wmux-test", "-c", "user.email=wmux@example.invalid", "add", ".");
  git(repository, "-c", "user.name=wmux-test", "-c", "user.email=wmux@example.invalid", "commit", "-qm", "fixture");
  const revision = git(repository, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(repository, "node_modules/.bin"), { recursive: true });
  executable(path.join(repository, "node_modules/.bin/playwright"), `#!/bin/sh\ntouch '${state}/canonical-playwright-executed'\nexit 97\n`);

  executable(path.join(bin, "docker"), `#!/bin/sh
LOG='${log}'; STATE='${state}'
{ printf 'docker cwd=<%s>' "$PWD"; for arg in "$@"; do printf ' <%s>' "$arg"; done; printf '\n'; } >>"$LOG"
ctl() { [ -f "$STATE/control-$1" ]; }; has() { [ -f "$STATE/$1" ]; }
val() { [ -f "$STATE/control-$1" ] && /bin/cat "$STATE/control-$1"; }
[ -n "\${DOCKER_CONFIG-}" ] && [ -d "$DOCKER_CONFIG" ] || exit 60
[ -z "$(/bin/ls -A "$DOCKER_CONFIG")" ] || ctl sudo-artifacts || exit 61
[ -z "\${NODE_OPTIONS-}\${TAR_OPTIONS-}\${GIT_DIR-}\${GIT_WORK_TREE-}\${HTTP_PROXY-}\${http_proxy-}" ] || exit 62
if ctl sudo-only && [ "\${WMUX_TEST_SUDO-}" != 1 ]; then exit 59; fi
if ctl sudo-artifacts && [ "\${WMUX_TEST_SUDO-}" = 1 ]; then chmod 700 "$DOCKER_CONFIG"; mkdir -p "$DOCKER_CONFIG/buildx"; : >"$DOCKER_CONFIG/buildx/current"; fi
for arg in "$@"; do case "$arg" in '${approvedWorktreeRoot}'/*) exit 58;; esac; done
if [ "$1" = context ] && [ "$2" = show ]; then printf 'default\n'; exit; fi
if [ "$1" = context ] && [ "$2" = inspect ]; then printf 'unix:///var/run/docker.sock\n'; exit; fi
if [ "$1" = --context ] || [ "$1" = --host ]; then shift 2; fi
if [ "$1" = info ]; then ctl pre-resource-fail && exit 1; printf 'engine-test\n'; exit; fi
cid='${containerId}'; nid='${networkId}'; iid='${imageId}'
ctl substitute-container && cid='${"d".repeat(64)}'
ctl substitute-network && nid='${"e".repeat(64)}'
if [ "$1" = ps ]; then case " $* " in *label=com.docker.compose.project=*) has container && printf '%s\n' "$cid" || true;; *name=^/*) has container && printf '%s\n' "$cid" || true;; esac; exit 0; fi
if [ "$1 $2" = 'network ls' ]; then case " $* " in *label=com.docker.compose.project=*) has network && printf '%s\n' "$nid" || true;; *name=^*) has network && printf '%s\n' "$nid" || true;; esac; exit 0; fi
if [ "$1 $2" = 'volume ls' ]; then exit 0; fi
if [ "$1" = compose ]; then
  env_file=; previous=; for arg in "$@"; do [ "$previous" != --env-file ] || env_file=$arg; previous=$arg; done
  case " $* " in
    *' config --format json '*)
      node -e '
        const fs=require("node:fs");const file=process.argv[1];const env=Object.fromEntries(fs.readFileSync(file,"utf8").trim().split("\\n").map(line=>{const i=line.indexOf("=");return [line.slice(0,i),line.slice(i+1)]}));
        if(env.WMUX_BUILD_CONTEXT.startsWith("${approvedWorktreeRoot}/"))process.exit(58);fs.writeFileSync(process.argv[2],env.WMUX_BUILD_REVISION);fs.writeFileSync(process.argv[3],env.COMPOSE_PROJECT_NAME);fs.writeFileSync(process.argv[4],env.WMUX_PUBLISH_HOST);fs.writeFileSync(process.argv[5],env.WMUX_PUBLISH_PORT);fs.writeFileSync(process.argv[6],env.WMUX_BUILD_CONTEXT);
        const proxy={ALL_PROXY:"",FTP_PROXY:"",HTTPS_PROXY:"",HTTP_PROXY:"",NO_PROXY:"",all_proxy:"",ftp_proxy:"",http_proxy:"",https_proxy:"",no_proxy:""};
        const service={build:{context:env.WMUX_BUILD_CONTEXT,dockerfile:"deploy/docker/Dockerfile",args:{...proxy,WMUX_REVISION:env.WMUX_BUILD_REVISION,WMUX_VERSION:env.WMUX_BUILD_VERSION}},cap_drop:["ALL"],command:null,container_name:env.COMPOSE_PROJECT_NAME+"-wmux",cpus:2,entrypoint:null,environment:{WMUX_BROWSER_AUTH_MODE:"shared-or-login",WMUX_HOST:"",WMUX_PORT:"3478",WMUX_PUBLIC_URL:env.WMUX_PUBLIC_URL,WMUX_PUBLISH_HOST:env.WMUX_PUBLISH_HOST,WMUX_REGISTRATION_TOKEN:env.WMUX_REGISTRATION_TOKEN,WMUX_TOKEN:env.WMUX_TOKEN},image:env.WMUX_IMAGE,init:true,ipc:"private",logging:{driver:"local",options:{"max-file":"3","max-size":"10m"}},mem_limit:1073741824,memswap_limit:1073741824,networks:{default:null},pids_limit:512,ports:[{mode:"ingress",host_ip:env.WMUX_PUBLISH_HOST,target:3478,published:env.WMUX_PUBLISH_PORT,protocol:"tcp"}],read_only:true,restart:"no",security_opt:["no-new-privileges:true"],tmpfs:["/home/node/.wmux:rw,nosuid,nodev,mode=0700,size=256m,uid=1000,gid=1000","/tmp:rw,nosuid,nodev,noexec,mode=1777,size=64m,uid=1000,gid=1000","/run:rw,nosuid,nodev,noexec,mode=0755,size=8m,uid=1000,gid=1000"],user:"node"};
        process.stdout.write(JSON.stringify({name:env.COMPOSE_PROJECT_NAME,networks:{default:{name:env.COMPOSE_PROJECT_NAME+"_default",driver:"bridge",ipam:{}}},services:{wmux:service}}));
      ' "$env_file" "$STATE/revision" "$STATE/project" "$STATE/host" "$STATE/port" "$STATE/build-context";;
    *' up -d --build '*) touch "$STATE/container" "$STATE/network" "$STATE/image";;
    *' ps '*) has container && printf 'Up (healthy)\n';;
    *' down --remove-orphans '*) rm -f "$STATE/container" "$STATE/network";;
  esac; exit
fi
revision=$(/bin/cat "$STATE/revision" 2>/dev/null); project=$(/bin/cat "$STATE/project" 2>/dev/null); host=$(/bin/cat "$STATE/host" 2>/dev/null); port=$(/bin/cat "$STATE/port" 2>/dev/null)
if [ "$1" = exec ]; then printf '1000\n'; exit; fi
if [ "$1" = inspect ]; then
  if [ "$2" != --format ]; then has container; exit; fi
  case "$3" in *State.Health.Status*) printf 'healthy\n';; *'{{.Image}}'*) printf '${imageId}\n';; *'"HostConfig"'*)
    node -e 'const [cid,nid,iid,p,r,host,port,portMode]=process.argv.slice(1);const binding=[{HostIp:host,HostPort:port}];const h={Binds:null,CapDrop:["ALL"],DeviceRequests:null,Devices:[],IpcMode:"private",LogConfig:{Type:"local",Config:{"max-file":"3","max-size":"10m"}},Memory:1073741824,MemorySwap:1073741824,NanoCpus:2000000000,NetworkMode:p+"_default",PidMode:"",PidsLimit:512,PortBindings:{"3478/tcp":binding},Privileged:false,ReadonlyRootfs:true,RestartPolicy:{Name:"no"},SecurityOpt:["no-new-privileges:true"],Tmpfs:{"/home/node/.wmux":"rw,nosuid,nodev,mode=700,size=268435456,uid=1000,gid=1000","/tmp":"rw,nosuid,nodev,noexec,mode=1777,size=67108864,uid=1000,gid=1000","/run":"rw,nosuid,nodev,noexec,mode=755,size=8388608,uid=1000,gid=1000"},VolumesFrom:null};process.stdout.write(JSON.stringify({Id:cid,Image:iid,Name:"/"+p+"-wmux",Config:{Image:"wmux-staging:"+r,Labels:{"com.docker.compose.project":p,"com.docker.compose.service":"wmux","org.opencontainers.image.revision":r},User:"node"},HostConfig:h,NetworkSettings:{Networks:{[p+"_default"]:{NetworkID:nid}},Ports:portMode==="null"?null:{"3478/tcp":binding}},Mounts:[]}))' "$cid" "$nid" "$iid" "$project" "$revision" "$host" "$port" "$(ctl null-realized-ports && printf null || printf bound)";; esac; exit
fi
if [ "$1 $2" = 'network inspect' ]; then if [ "$3" != --format ]; then has network; exit; fi; printf '{"Attachable":false,"Driver":"bridge","Id":"%s","Internal":false,"Labels":{"com.docker.compose.project":"%s","com.docker.compose.network":"default"},"Name":"%s_default","Options":{}}\n' "$nid" "$project" "$project"; exit; fi
if [ "$1 $2" = 'image inspect' ]; then printf '{"Id":"${imageId}","Labels":{"org.opencontainers.image.revision":"%s"}}\n' "$revision"; exit; fi
exit 72
`);
  executable(path.join(bin, "npm"), `#!/bin/sh
[ "$*" = 'ci --ignore-scripts --no-audit --no-fund' ] || exit 90
[ -z "\${WMUX_TOKEN-}\${WMUX_REGISTRATION_TOKEN-}\${WMUX_E2E_TOKEN-}\${WMUX_E2E_REGISTRATION_TOKEN-}\${WMUX_E2E_BASE_URL-}" ] || exit 91
[ -f package.json ] && [ -f package-lock.json ] || exit 92
printf 'npm-ci cwd=%s token=no reg=no\n' "$PWD" >>'${log}'
mkdir -p node_modules/.bin node_modules/fake
cat >node_modules/fake/playwright <<'RUNNER'
#!/bin/sh
printf 'playwright cwd=%s rev=%s token=%s reg=%s args=%s\n' "$PWD" "\${WMUX_BUILD_REVISION-}" "$([ -n "\${WMUX_E2E_TOKEN-}" ] && printf yes || printf no)" "$([ -n "\${WMUX_E2E_REGISTRATION_TOKEN-}" ] && printf yes || printf no)" "$*" >>'${log}'
[ ! -f '${state}/control-e2e-drift' ] || chmod 700 package.json
[ ! -f '${state}/control-e2e-config-drift' ] || chmod 700 playwright.browser.config.ts
[ ! -f '${state}/control-e2e-dependency-drift' ] || printf 'drift\n' >node_modules/fake/drift
RUNNER
chmod 700 node_modules/fake/playwright
ln -s ../fake/playwright node_modules/.bin/playwright
`);
  executable(path.join(bin, "sudo"), `#!/bin/sh
case " $* " in *' remove-docker-config-tree '*) touch '${state}/sudo-cleanup';; esac
[ "$1" = -n ] || exit 81
shift
[ "$1" = env ] || exit 82
shift
[ "$1" = -i ] || exit 83
shift
exec env -i WMUX_TEST_SUDO=1 "$@"
`);
  const port = String(20_000 + Math.floor(Math.random() * 20_000));
  const environment: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, WMUX_STAGING_PROJECT: project,
    WMUX_STAGING_PUBLISH_HOST: privateHost, WMUX_STAGING_PUBLISH_PORT: port, WMUX_STAGING_RUNTIME_ROOT: runtime,
    WMUX_STAGING_WORKTREE_ROOT: approvedWorktreeRoot,
  };
  return { directory, repository, runtime, stateHome, state, bin, log, project, revision, port, environment, script: path.join(repository, "scripts/wmux-docker-staging") };
}

const run = (fixture: Fixture, command: string, changes: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync("/bin/sh", [fixture.script, command], {
    cwd: os.tmpdir(), env: { ...fixture.environment, ...changes }, encoding: "utf8", timeout: 30_000,
  });
  const runtimeRoot = changes.WMUX_STAGING_RUNTIME_ROOT === ""
    ? path.join(changes.XDG_STATE_HOME ?? fixture.stateHome, "wmux", "docker-staging")
    : changes.WMUX_STAGING_RUNTIME_ROOT ?? fixture.runtime;
  assert.equal(fs.existsSync(path.join(runtimeRoot, `.lock-${fixture.project}`)), false,
    `operation lock remained after ${command} (status ${result.status}): ${result.stderr}`);
  return result;
};

const startHttpFixture = (directory: string, mode: string, port: string): ChildProcess => {
  const server = path.join(directory, `server-${mode}.mjs`);
  fs.writeFileSync(server, `import http from 'node:http';const mode=process.argv[2];http.createServer((req,res)=>{if(mode==='slow')return;if(mode==='redirect'){res.writeHead(302,{location:'/elsewhere'});return res.end();}if(mode==='endless'){res.writeHead(200,{'content-type':'application/json'});return setInterval(()=>res.write(' '),100);}if(mode==='oversized'){res.writeHead(200,{'content-type':'application/json'});return res.end('x'.repeat(300000));}res.writeHead(200,{'content-type':'application/json'});res.end(req.url==='/api/health'?'{"ok":true}':'{"settings":{"groupSidebarSessionsByHost":true}}')}).listen(Number(process.argv[3]),'0.0.0.0');`);
  const child = spawn(process.execPath, [server, mode, port], { stdio: "ignore" });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  return child;
};

test("bootstrap ignores source attributes, filters, replace refs, untracked files, and hostile Git/tool environment", () => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(path.join(fixture.repository, ".git/info"), { recursive: true });
    fs.writeFileSync(path.join(fixture.repository, ".git/info/attributes"), "scripts/wmux-docker-staging export-ignore\n*.mjs export-subst filter=hostile\n");
    git(fixture.repository, "config", "filter.hostile.clean", "sh -c 'exit 91'");
    git(fixture.repository, "config", "filter.hostile.smudge", "sh -c 'exit 92'");
    fs.writeFileSync(path.join(fixture.repository, "source-untracked-secret"), "must not materialize\n");
    const other = git(fixture.repository, "commit-tree", `${fixture.revision}^{tree}`, "-p", fixture.revision, "-m", "replacement");
    git(fixture.repository, "replace", fixture.revision, other);
    const hostile = path.join(fixture.directory, "hostile"); fs.mkdirSync(hostile);
    const result = run(fixture, "up", { NODE_OPTIONS: "--invalid", TAR_OPTIONS: "--delete", GIT_DIR: hostile, GIT_WORK_TREE: hostile, GIT_OBJECT_DIRECTORY: hostile, GIT_ALTERNATE_OBJECT_DIRECTORIES: hostile });
    assert.equal(result.status, 0, `${result.stderr}\n${fs.existsSync(fixture.log) ? fs.readFileSync(fixture.log, "utf8") : ""}`);
    const identity = metadata(path.join(fixture.runtime, fixture.project, "identity.env"));
    const buildIdentity = metadata(path.join(fixture.runtime, fixture.project, "build-context.env"));
    assert.equal(fs.existsSync(path.join(identity.WMUX_WORKTREE, "source-untracked-secret")), false);
    assert.equal(fs.existsSync(path.join(buildIdentity.WMUX_BUILD_CONTEXT, "source-untracked-secret")), false);
    assert.equal(fs.existsSync(path.join(buildIdentity.WMUX_BUILD_CONTEXT, ".git")), false);
    assert.equal(fs.existsSync(path.join(buildIdentity.WMUX_BUILD_CONTEXT, "node_modules")), false);
    assert.equal(fs.lstatSync(path.join(buildIdentity.WMUX_BUILD_CONTEXT, "scripts/wmux-docker-staging")).mode & 0o777, 0o700);
    assert.equal(fs.readlinkSync(path.join(buildIdentity.WMUX_BUILD_CONTEXT, "fixture-link")), "package.json");
    assert.equal(git(identity.WMUX_WORKTREE, "rev-parse", "HEAD"), fixture.revision);
    { const down = run(fixture, "down"); assert.equal(down.status, 0, down.stderr); }
  } finally { removeFixture(fixture); }
});

test("bootstrap rejects modified launcher and tracked or staged source drift", () => {
  for (const kind of ["launcher", "tracked", "staged"]) {
    const fixture = makeFixture();
    try {
      const target = kind === "launcher" ? fixture.script : path.join(fixture.repository, "package.json");
      fs.appendFileSync(target, " \n");
      if (kind === "staged") git(fixture.repository, "add", "package.json");
      const result = run(fixture, "up");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, kind === "launcher" ? /launcher bytes differ/ : kind === "staged" ? /staged checkout changes/ : /tracked checkout changes/);
    } finally { removeFixture(fixture); }
  }
});

test("default staging root is owner-local state even when the managed shared workspace exists", () => {
  const fixture = makeFixture();
  try {
    const defaultRuntime = path.join(fixture.stateHome, "wmux", "docker-staging");
    const result = run(fixture, "up", {
      WMUX_STAGING_RUNTIME_ROOT: "",
      XDG_STATE_HOME: fixture.stateHome,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(defaultRuntime, fixture.project, "identity.env")), true);
    assert.equal(fs.existsSync(path.join(fixture.runtime, fixture.project)), false);
    assert.equal(run(fixture, "down", { WMUX_STAGING_RUNTIME_ROOT: "", XDG_STATE_HOME: fixture.stateHome }).status, 0);
  } finally { removeFixture(fixture); }
});

test("sudo Compose uses only the verified owner-local mirror, never the root-squashed worktree", () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(path.join(fixture.state, "control-sudo-only"), "");
    const up = run(fixture, "up");
    assert.equal(up.status, 0, `${up.stderr}\n${fs.existsSync(fixture.log) ? fs.readFileSync(fixture.log, "utf8") : ""}`);
    const runtimeDirectory = path.join(fixture.runtime, fixture.project);
    const identity = metadata(path.join(runtimeDirectory, "identity.env"));
    const buildIdentity = metadata(path.join(runtimeDirectory, "build-context.env"));
    const staging = metadata(path.join(runtimeDirectory, "staging.env"));
    assert.equal(fs.lstatSync(identity.WMUX_WORKTREE).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(buildIdentity.WMUX_BUILD_CONTEXT).mode & 0o777, 0o700);
    assert.equal(buildIdentity.WMUX_BUILD_CONTEXT, path.join(runtimeDirectory, "build-context"));
    assert.equal(staging.WMUX_BUILD_CONTEXT, buildIdentity.WMUX_BUILD_CONTEXT);
    assert.equal(staging.WMUX_BUILD_TREE_DIGEST, buildIdentity.WMUX_BUILD_TREE_DIGEST);
    assert.equal(Object.values(staging).includes(identity.WMUX_WORKTREE), false);
    assert.equal(staging.WMUX_DOCKER_MODE, "sudo");
    assert.equal(fs.readFileSync(path.join(fixture.state, "build-context"), "utf8"), buildIdentity.WMUX_BUILD_CONTEXT);
    const log = fs.readFileSync(fixture.log, "utf8");
    const escapedMirror = buildIdentity.WMUX_BUILD_CONTEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedWorktree = identity.WMUX_WORKTREE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const composeCwds = [...log.matchAll(/docker cwd=<([^>]+)>.* <compose>/g)].map((match) => match[1]);
    assert.ok(composeCwds.length > 0, log);
    assert.ok(composeCwds.every((cwd) => cwd === buildIdentity.WMUX_BUILD_CONTEXT), log);
    assert.ok(composeCwds.every((cwd) => cwd !== identity.WMUX_WORKTREE && cwd !== os.tmpdir()), log);
    assert.match(log, new RegExp(`compose.*-f.*${escapedMirror}/deploy/docker/docker-compose\\.staging\\.yml`));
    assert.doesNotMatch(log, new RegExp(escapedWorktree));
    const down = run(fixture, "down");
    assert.equal(down.status, 0, down.stderr);
    assert.equal(fs.existsSync(runtimeDirectory), false);
    assert.equal(fs.existsSync(identity.WMUX_WORKTREE), false);
  } finally { removeFixture(fixture); }
});

test("sudo Docker Buildx artifacts are removed after successful and failed operations", () => {
  for (const failSelection of [false, true]) {
    const fixture = makeFixture();
    try {
      fs.writeFileSync(path.join(fixture.state, "control-sudo-only"), "");
      fs.writeFileSync(path.join(fixture.state, "control-sudo-artifacts"), "");
      if (failSelection) fs.writeFileSync(path.join(fixture.state, "control-pre-resource-fail"), "");
      const result = run(fixture, "up");
      assert.equal(result.status === 0, !failSelection, result.stderr);
      assert.equal(fs.existsSync(path.join(fixture.state, "sudo-cleanup")), false);
      if (!failSelection) assert.equal(run(fixture, "down").status, 0);
    } finally { removeFixture(fixture); }
  }
});

test("Docker config cleanup accepts only the exact non-symlink lock child and handles root-owned Buildx state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-docker-config-cleanup-")); fs.chmodSync(directory, 0o700);
  const lock = path.join(directory, ".lock-wmux-staging-policy");
  const config = path.join(lock, "docker-config");
  const outside = path.join(lock, "outside");
  fs.mkdirSync(config, { recursive: true, mode: 0o700 }); fs.mkdirSync(outside, { mode: 0o700 });
  try {
    const policy = (...args: string[]) => spawnSync(process.execPath, [sourcePolicy, ...args], { encoding: "utf8" });
    assert.equal(policy("validate-docker-config-path", lock, config).status, 0);
    assert.notEqual(policy("validate-docker-config-path", lock, outside).status, 0);
    fs.rmdirSync(config); fs.symlinkSync(outside, config);
    assert.notEqual(policy("validate-docker-config-path", lock, config).status, 0);
    assert.notEqual(policy("remove-docker-config-tree", lock, config).status, 0);
    assert.equal(fs.existsSync(outside), true);
    fs.unlinkSync(config); fs.mkdirSync(path.join(config, "buildx"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(config, "buildx", "current"), "stub\n", { mode: 0o600 });
    const buildx = path.join(config, "buildx");
    const chown = spawnSync("sudo", ["-n", "chown", "-R", "0:0", buildx], { encoding: "utf8" });
    if (chown.status === 0) {
      assert.equal(policy("docker-config-cleanup-authority", lock, config).stdout.trim(), "sudo");
      assert.notEqual(policy("remove-docker-config-tree", lock, config).status, 0);
      const elevated = spawnSync("sudo", ["-n", process.execPath, sourcePolicy, "remove-docker-config-tree", lock, config], { encoding: "utf8" });
      assert.equal(elevated.status, 0, elevated.stderr);
    } else {
      assert.equal(policy("docker-config-cleanup-authority", lock, config).stdout.trim(), "direct");
      assert.equal(policy("remove-docker-config-tree", lock, config).status, 0);
    }
    assert.equal(fs.existsSync(config), false);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    const buildx = path.join(config, "buildx");
    if (fs.existsSync(buildx)) spawnSync("sudo", ["-n", "chown", "-R", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, buildx]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local build-context drift is rejected and retained for audit", () => {
  const fixture = makeFixture();
  try {
    const up = run(fixture, "up");
    assert.equal(up.status, 0, up.stderr);
    const runtimeDirectory = path.join(fixture.runtime, fixture.project);
    const identity = metadata(path.join(runtimeDirectory, "identity.env"));
    const buildIdentityPath = path.join(runtimeDirectory, "build-context.env");
    const buildIdentity = metadata(buildIdentityPath);
    const mirror = buildIdentity.WMUX_BUILD_CONTEXT;
    const packagePath = path.join(mirror, "package.json");
    const composePath = path.join(mirror, "deploy/docker/docker-compose.staging.yml");

    fs.chmodSync(packagePath, 0o400);
    assert.match(run(fixture, "status").stderr, /local build context owner mode drift/);
    fs.chmodSync(packagePath, 0o600);

    const untracked = path.join(mirror, "untracked");
    fs.writeFileSync(untracked, "drift\n", { mode: 0o600 });
    assert.match(run(fixture, "status").stderr, /local build context paths differ/);
    fs.unlinkSync(untracked);

    const composeBytes = fs.readFileSync(composePath);
    fs.unlinkSync(composePath); fs.symlinkSync("/etc/passwd", composePath);
    assert.match(run(fixture, "status").stderr, /local build context (file type drift|symlink is absolute)/);
    fs.unlinkSync(composePath); fs.writeFileSync(composePath, composeBytes, { mode: 0o600 });

    fs.appendFileSync(packagePath, "drift\n");
    assert.match(run(fixture, "status").stderr, /local build context blob drift/);
    fs.copyFileSync(path.join(identity.WMUX_WORKTREE, "package.json"), packagePath);
    fs.chmodSync(packagePath, 0o600);

    assert.equal(fs.existsSync(runtimeDirectory), true);
    assert.equal(fs.existsSync(buildIdentityPath), true);
    assert.equal(run(fixture, "down").status, 0);
  } finally { removeFixture(fixture); }
});

test("detached worktree rejects file mode, symlink, and E2E checkout drift and binds E2E to the build revision", () => {
  const fixture = makeFixture();
  let server: ChildProcess | undefined;
  try {
    { const up = run(fixture, "up"); assert.equal(up.status, 0, `${up.stderr}\n${fs.existsSync(fixture.log) ? fs.readFileSync(fixture.log, "utf8") : ""}`); }
    const identity = metadata(path.join(fixture.runtime, fixture.project, "identity.env"));
    const packagePath = path.join(identity.WMUX_WORKTREE, "package.json");
    fs.chmodSync(packagePath, 0o700);
    assert.match(run(fixture, "status").stderr, /(tracked checkout|worktree validation failed)/);
    fs.chmodSync(packagePath, 0o600);
    const composePath = path.join(identity.WMUX_WORKTREE, "deploy/docker/docker-compose.staging.yml");
    fs.unlinkSync(composePath); fs.symlinkSync("/etc/passwd", composePath);
    assert.match(run(fixture, "status").stderr, /(tracked checkout|worktree validation failed)/);
    fs.unlinkSync(composePath); fs.writeFileSync(composePath, fs.readFileSync(path.join(fixture.repository, "deploy/docker/docker-compose.staging.yml"))); fs.chmodSync(composePath, 0o600);
    server = startHttpFixture(fixture.directory, "ok", fixture.port);
    for (const [control, target] of [["e2e-drift", packagePath], ["e2e-config-drift", path.join(identity.WMUX_WORKTREE, "playwright.browser.config.ts")], ["e2e-dependency-drift", packagePath]]) {
      const controlPath = path.join(fixture.state, `control-${control}`); fs.writeFileSync(controlPath, "");
      const drift = run(fixture, "e2e");
      assert.notEqual(drift.status, 0);
      assert.match(drift.stderr, /(executable mode drift|changed source or dependency boundaries|dependency tree changed)/);
      fs.rmSync(controlPath); fs.chmodSync(target, 0o600);
    }
    const e2e = run(fixture, "e2e");
    assert.equal(e2e.status, 0, e2e.stderr);
    const log = fs.readFileSync(fixture.log, "utf8");
    const secrets = metadata(path.join(fixture.runtime, fixture.project, "staging.env"));
    const escapedWorktree = identity.WMUX_WORKTREE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(log, new RegExp(`npm-ci cwd=${escapedWorktree} token=no reg=no`));
    assert.match(log, new RegExp(`playwright cwd=${escapedWorktree} rev=${fixture.revision} token=yes reg=yes args=test --config=playwright.browser.config.ts`));
    assert.equal(fs.existsSync(path.join(fixture.state, "canonical-playwright-executed")), false);
    assert.equal(fs.existsSync(path.join(identity.WMUX_WORKTREE, "node_modules")), false);
    assert.doesNotMatch(log, /WMUX_TOKEN=|WMUX_REGISTRATION_TOKEN=/);
    assert.equal(log.includes(secrets.WMUX_TOKEN), false); assert.equal(log.includes(secrets.WMUX_REGISTRATION_TOKEN), false);
    assert.equal(run(fixture, "down").status, 0);
  } finally { server?.kill(); removeFixture(fixture); }
});

test("pre-resource interruption down audits and removes identity or provision worktrees without residue", () => {
  for (const provisionOnly of [false, true]) {
    const fixture = makeFixture();
    const before = new Set(fs.readdirSync(approvedWorktreeRoot).filter((name) => name.startsWith("stage-")));
    try {
      fs.writeFileSync(path.join(fixture.state, "control-pre-resource-fail"), "");
      const up = run(fixture, "up"); assert.notEqual(up.status, 0); assert.match(up.stderr, /Docker is unavailable/);
      fs.rmSync(path.join(fixture.state, "control-pre-resource-fail"));
      const identityPath = path.join(fixture.runtime, fixture.project, "identity.env");
      const identity = metadata(identityPath);
      assert.equal(fs.existsSync(path.join(fixture.runtime, fixture.project, "staging.env")), false);
      if (provisionOnly) fs.rmSync(identityPath);
      const down = run(fixture, "down"); assert.equal(down.status, 0, down.stderr);
      assert.equal(fs.existsSync(identity.WMUX_WORKTREE), false);
      assert.equal(fs.existsSync(path.join(fixture.runtime, fixture.project)), false);
      const after = fs.readdirSync(approvedWorktreeRoot).filter((name) => name.startsWith("stage-") && !before.has(name));
      assert.deepEqual(after, []);
    } finally { removeFixture(fixture); }
  }
});

test("worktree cleanup refuses identity substitution and retains evidence", () => {
  const fixture = makeFixture();
  try {
    { const up = run(fixture, "up"); assert.equal(up.status, 0, `${up.stderr}\n${fs.existsSync(fixture.log) ? fs.readFileSync(fixture.log, "utf8") : ""}`); }
    const identityPath = path.join(fixture.runtime, fixture.project, "identity.env");
    const identity = metadata(identityPath);
    const moved = `${identity.WMUX_WORKTREE}-moved`;
    fs.renameSync(identity.WMUX_WORKTREE, moved); fs.mkdirSync(identity.WMUX_WORKTREE, { mode: 0o700 });
    const result = run(fixture, "down");
    assert.notEqual(result.status, 0); assert.match(result.stderr, /identity validation failed/);
    assert.equal(fs.existsSync(identityPath), true);
    fs.rmdirSync(identity.WMUX_WORKTREE); fs.renameSync(moved, identity.WMUX_WORKTREE);
    assert.equal(run(fixture, "down").status, 0);
    assert.equal(fs.existsSync(identity.WMUX_WORKTREE), false);
  } finally { removeFixture(fixture); }
});

test("exact resource IDs are recorded, substitutions fail closed, and audited down retains only the candidate image", () => {
  const fixture = makeFixture();
  try {
    { const up = run(fixture, "up"); assert.equal(up.status, 0, up.stderr); }
    const live = metadata(path.join(fixture.runtime, fixture.project, "live.env"));
    assert.equal(live.WMUX_CONTAINER_ID, containerId); assert.equal(live.WMUX_NETWORK_ID, networkId); assert.equal(live.WMUX_IMAGE_ID, imageId);
    for (const control of ["substitute-container", "substitute-network"]) {
      const controlPath = path.join(fixture.state, `control-${control}`); fs.writeFileSync(controlPath, "");
      const status = run(fixture, "status"); assert.notEqual(status.status, 0); assert.match(status.stderr, /substitution detected/);
      fs.rmSync(controlPath);
    }
    const nullPorts = path.join(fixture.state, "control-null-realized-ports"); fs.writeFileSync(nullPorts, "");
    { const status = run(fixture, "status"); assert.notEqual(status.status, 0); assert.match(status.stderr, /live realized ports must be an object/); }
    fs.rmSync(nullPorts);
    const down = run(fixture, "down"); assert.equal(down.status, 0, down.stderr);
    assert.equal(fs.existsSync(path.join(fixture.state, "image")), true);
    const log = fs.readFileSync(fixture.log, "utf8");
    assert.match(log, /compose.*down.*--remove-orphans/); assert.doesNotMatch(log, /--volumes|\bprune\b|volume rm|network rm|container rm/);
  } finally { removeFixture(fixture); }
});

test("Dockerfile logical RUN parser rejects every --mount spelling and multiline position", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-dockerfile-policy-")); fs.chmodSync(directory, 0o700);
  try {
    const file = path.join(directory, "Dockerfile");
    for (const source of [
      "FROM scratch\nRUN --mount=type=cache true\n", "FROM scratch\nrUn echo before \\\n+ --MoUnT = type=bind echo after\n",
      "# syntax=docker/dockerfile:1.7\n# escape=`\nFROM scratch\nRUN echo before `\n+ --mount echo after\n", "FROM scratch\nRUN [\"--mount\",\"echo\"]\n",
      "FROM scratch\nRUN <<EOF\necho --mount\nEOF\n",
      "FROM scratch\nONBUILD RUN --mount=type=secret echo blocked\n",
      "FROM scratch\noNbUiLd rUn echo before \\\n+ --MoUnT type=bind echo blocked\n",
      "# syntax=docker/dockerfile:1.7\n# escape=`\nFROM scratch\nONBUILD RUN echo before `\n+ --mount=type=cache echo blocked\n",
    ]) {
      fs.writeFileSync(file, source, { mode: 0o600 });
      const result = spawnSync(process.execPath, [sourcePolicy, "validate-dockerfile", file], { encoding: "utf8" });
      assert.notEqual(result.status, 0, source); assert.match(result.stderr, /forbidden --mount/);
    }
    fs.writeFileSync(file, "FROM scratch\n# RUN --mount=type=cache false\nRUN echo ok\n", { mode: 0o600 });
    assert.equal(spawnSync(process.execPath, [sourcePolicy, "validate-dockerfile", file]).status, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("bounded Node smoke rejects redirects, slow/endless, and oversized HTTP without response files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-smoke-policy-")); fs.chmodSync(directory, 0o700);
  const revision = "d".repeat(40); const envFile = path.join(directory, "staging.env");
  fs.writeFileSync(envFile, `WMUX_BUILD_REVISION=${revision}\nWMUX_TOKEN=${"e".repeat(64)}\n`, { mode: 0o600 });
  try {
    for (const mode of ["redirect", "slow", "endless", "oversized"]) {
      const port = String(40_000 + Math.floor(Math.random() * 15_000));
      const server = startHttpFixture(directory, mode, port);
      try {
        const before = fs.readdirSync(directory).sort();
        const result = spawnSync(process.execPath, [sourceSmoke, `http://127.0.0.1:${port}`, envFile, revision], { encoding: "utf8", timeout: 12_000 });
        assert.notEqual(result.status, 0, mode);
        assert.deepEqual(fs.readdirSync(directory).sort(), before);
      } finally { server.kill(); }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

const baselineCompose = (revision = "f".repeat(40)) => {
  const project = "wmux-staging-policy"; const proxy = { ALL_PROXY: "", FTP_PROXY: "", HTTPS_PROXY: "", HTTP_PROXY: "", NO_PROXY: "", all_proxy: "", ftp_proxy: "", http_proxy: "", https_proxy: "", no_proxy: "" };
  return { name: project, networks: { default: { name: `${project}_default`, driver: "bridge", ipam: {} } }, services: { wmux: {
    build: { context: "/candidate", dockerfile: "deploy/docker/Dockerfile", args: { ...proxy, WMUX_REVISION: revision, WMUX_VERSION: `staging-${revision.slice(0, 12)}` } }, cap_drop: ["ALL"], command: null, container_name: `${project}-wmux`, cpus: 2, entrypoint: null,
    environment: { WMUX_BROWSER_AUTH_MODE: "shared-or-login", WMUX_HOST: "", WMUX_PORT: "3478", WMUX_PUBLIC_URL: "http://100.64.0.10:13478", WMUX_PUBLISH_HOST: "100.64.0.10", WMUX_REGISTRATION_TOKEN: "b".repeat(64), WMUX_TOKEN: "a".repeat(64) }, image: `wmux-staging:${revision}`, init: true, ipc: "private", logging: { driver: "local", options: { "max-file": "3", "max-size": "10m" } }, mem_limit: 1073741824, memswap_limit: 1073741824, networks: { default: null }, pids_limit: 512,
    ports: [{ mode: "ingress", host_ip: "100.64.0.10", target: 3478, published: "13478", protocol: "tcp" }], read_only: true, restart: "no", security_opt: ["no-new-privileges:true"], tmpfs: ["/home/node/.wmux:rw,nosuid,nodev,mode=0700,size=256m,uid=1000,gid=1000", "/tmp:rw,nosuid,nodev,noexec,mode=1777,size=64m,uid=1000,gid=1000", "/run:rw,nosuid,nodev,noexec,mode=0755,size=8m,uid=1000,gid=1000"], user: "node",
  } } };
};

test("Compose policy reads protected secrets by file path and rejects token or model drift", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-compose-policy-")); fs.chmodSync(directory, 0o700);
  const envFile = path.join(directory, "env"); fs.writeFileSync(envFile, `WMUX_TOKEN=${"a".repeat(64)}\nWMUX_REGISTRATION_TOKEN=${"b".repeat(64)}\n`, { mode: 0o600 });
  const revision = "f".repeat(40); const project = "wmux-staging-policy";
  const validate = (value: unknown, file = envFile) => spawnSync(process.execPath, [sourcePolicy, "validate-compose", project, "/candidate", "100.64.0.10", "13478", `wmux-staging:${revision}`, revision, `staging-${revision.slice(0, 12)}`, "http://100.64.0.10:13478", file], { input: JSON.stringify(value), encoding: "utf8" });
  try {
    assert.equal(validate(baselineCompose()).status, 0);
    for (const pid of ["private", "host", "container:other"]) {
      const withPid = structuredClone(baselineCompose()) as any; withPid.services.wmux.pid = pid;
      assert.notEqual(validate(withPid).status, 0, pid);
    }
    const emptyPid = structuredClone(baselineCompose()) as any; emptyPid.services.wmux.pid = "";
    assert.equal(validate(emptyPid).status, 0);
    for (const field of ["internal", "attachable"]) {
      const broadened = structuredClone(baselineCompose()) as any; broadened.networks.default[field] = true;
      assert.notEqual(validate(broadened).status, 0, field);
    }
    const mounted = structuredClone(baselineCompose()) as any; mounted.services.wmux.build.ssh = ["default"]; assert.notEqual(validate(mounted).status, 0);
    fs.writeFileSync(envFile, `WMUX_TOKEN=${"a".repeat(64)}\nWMUX_REGISTRATION_TOKEN=${"a".repeat(64)}\n`, { mode: 0o600 }); assert.notEqual(validate(baselineCompose()).status, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("dedicated staging artifacts preserve exact private publish and omit production/broad teardown paths", () => {
  const compose = fs.readFileSync(path.join(sourceRoot, "deploy/docker/docker-compose.staging.yml"), "utf8");
  const script = fs.readFileSync(path.join(sourceRoot, "scripts/wmux-docker-staging"), "utf8");
  const policy = fs.readFileSync(sourcePolicy, "utf8");
  assert.match(compose, /WMUX_PUBLISH_HOST.*WMUX_PUBLISH_PORT/); assert.match(compose, /internal: false/); assert.match(compose, /attachable: false/);
  assert.doesNotMatch(compose, /^volumes:/m); assert.doesNotMatch(script, /docker-compose\.yml|--volumes|\bprune\b|git archive|candidate\.tar/);
  assert.match(script, /runtime_root=\$\{XDG_STATE_HOME:-\$\{HOME:\?HOME is required\}\/\.local\/state\}\/wmux\/docker-staging/);
  assert.doesNotMatch(script, /\.workspace\/deployments\/wmux-staging/);
  assert.match(script, /git_cmd pack-objects --stdout --revs <"\$object_revs" >"\$object_pack"/);
  assert.match(script, /isolated_git index-pack --stdin <"\$object_pack"/);
  assert.match(script, /create-build-context.*"\$candidate_context".*"\$build_context"/);
  assert.match(script, /-f "\$build_context\/deploy\/docker\/docker-compose\.staging\.yml"/);
  assert.doesNotMatch(script, /pack-objects "\$isolated_repo\/objects\/pack\/pack"/);
  assert.doesNotMatch(script, /\b(?:tar|cp)\b/);
  assert.doesNotMatch(policy, /spawnSync\("(?:tar|cp)"/);
  assert.match(policy, /validateCommittedTree/); assert.match(policy, /O_EXCL/); assert.match(policy, /O_NOFOLLOW/);
  assert.match(policy, /validateCleanupWorktree/); assert.match(policy, /"worktree", "remove", "--force"/);
});
