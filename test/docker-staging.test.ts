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
const runnerContainerId = "d".repeat(64);
const runnerImageId = `sha256:${"7".repeat(64)}`;
const runnerImage = "mcr.microsoft.com/playwright@sha256:57b65fdc9ceabe0ef613124c7bbe2babcf9362c4d85e382fe3b03604e84b428a";

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
  const safeWorktree = (value: string | undefined): value is string => {
    if (!value) return false;
    const basename = path.basename(value);
    return path.dirname(value) === approvedWorktreeRoot && value.startsWith(approvedWorktreeRoot + path.sep)
      && /^stage-[0-9a-f]{12}-[0-9a-f]{16}$/.test(basename);
  };
  const removeWorktree = (metadataPath: string) => {
    let values: Record<string, string>;
    try {
      values = metadata(metadataPath);
    } catch {
      return;
    }
    const worktree = values.WMUX_WORKTREE;
    if (!safeWorktree(worktree)) return;
    const repository = values.WMUX_ISOLATED_REPOSITORY;
    if (repository && fs.existsSync(repository)) {
      spawnSync("git", ["--git-dir", repository, "worktree", "remove", "--force", worktree]);
    }
    if (fs.existsSync(worktree)) {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  };
  try {
    removeWorktree(path.join(fixture.runtime, fixture.project, "identity.env"));
    removeWorktree(path.join(fixture.runtime, fixture.project, "provision.env"));
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
};

function makeFixture(options: { runnerTimeoutSeconds?: number } = {}) {
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
    "deploy/docker/e2e-runner-bootstrap",
  ]) {
    const target = path.join(repository, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relative), target);
  }
  fs.chmodSync(path.join(repository, "scripts/wmux-docker-staging"), 0o755);
  if (options.runnerTimeoutSeconds !== undefined) {
    const launcher = path.join(repository, "scripts/wmux-docker-staging");
    fs.writeFileSync(launcher, fs.readFileSync(launcher, "utf8").replace('"$runtime_dir/e2e-run.log" 1800', `"$runtime_dir/e2e-run.log" ${options.runnerTimeoutSeconds}`), { mode: 0o755 });
  }
  fs.writeFileSync(path.join(repository, "package.json"), '{"name":"candidate","scripts":{"test:e2e:browser:chromium":"true"}}\n');
  fs.writeFileSync(path.join(repository, "package-lock.json"), JSON.stringify({ name: "candidate", lockfileVersion: 3, requires: true, packages: {
    "": { name: "candidate" }, "node_modules/@playwright/test": { version: "1.61.0" },
    "node_modules/playwright": { version: "1.61.0" }, "node_modules/playwright-core": { version: "1.61.0" },
  } }) + "\n");
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
if [ "$1" = pull ]; then [ "$2" = '${runnerImage}' ] || exit 73; exit 0; fi
if [ "$1 $2" = 'image inspect' ] && [ "$5" = '${runnerImage}' ]; then
  case "$4" in *'index .Config "Cmd"'*'index .Config "Entrypoint"'*'index .Config "Env"'*'index .Config "Labels"'*) ;; *) exit 77;; esac
  ctl runner-image-drift && digest='mcr.microsoft.com/playwright@sha256:${"8".repeat(64)}' || digest='${runnerImage}'
  if ctl runner-image-optional-absent; then
    printf '{"Id":"${runnerImageId}","RepoDigests":["%s"],"Config":{"Cmd":null,"Entrypoint":null,"Env":["PATH=/usr/bin:/bin","PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"],"Labels":null}}\n' "$digest"
  elif ctl runner-image-malformed; then
    printf '{"Id":"${runnerImageId}","RepoDigests":["%s"],"Config":{"Cmd":"/bin/sh","Entrypoint":null,"Env":["PATH=/usr/bin:/bin","PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"],"Labels":null}}\n' "$digest"
  elif ctl runner-image-unexpected; then
    printf '{"Id":"${runnerImageId}","RepoDigests":["%s"],"Config":{"Cmd":["/bin/sh"],"Entrypoint":null,"Env":["PATH=/usr/bin:/bin","PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"],"Labels":null,"Unexpected":null}}\n' "$digest"
  else
    printf '{"Id":"${runnerImageId}","RepoDigests":["%s"],"Config":{"Cmd":["/bin/sh"],"Entrypoint":null,"Env":["PATH=/usr/bin:/bin","PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"],"Labels":null}}\n' "$digest"
  fi
  exit
fi
if [ "$1" = create ]; then
  ctl runner-create-fail && exit 74
  interactive=0; previous=; for arg in "$@"; do
    [ "$arg" != --interactive ] || interactive=1
    case "$previous" in
      --name) printf '%s' "$arg" >"$STATE/runner-name";; --user) printf '%s' "$arg" >"$STATE/runner-user";;
      --mount) source=\${arg#*src=}; source=\${source%%,*}; case "$arg" in *dst=/workspace,*) printf '%s' "$source" >"$STATE/runner-context";; *dst=/runner-bootstrap,*) printf '%s' "$source" >"$STATE/runner-bootstrap";; esac;;
      --env) case "$arg" in WMUX_BUILD_REVISION=*) printf '%s' "\${arg#*=}" >"$STATE/runner-revision";; WMUX_E2E_BASE_URL=*) printf '%s' "\${arg#*=}" >"$STATE/runner-url";; esac;;
    esac
    previous=$arg
  done
  [ "$interactive" = 1 ] || exit 78
  touch "$STATE/runner"; printf '${runnerContainerId}\n' >"$STATE/runner-id"; printf '${runnerContainerId}\n'; exit
fi
if [ "$1" = start ]; then
  [ "$#" = 2 ] && [ "$2" = '${runnerContainerId}' ] || exit 76
  ctl runner-start-fail && exit 74
  touch "$STATE/runner-started"
  printf '${runnerContainerId}\n'
  exit 0
fi
if [ "$1" = attach ]; then
  [ "$#" = 3 ] && [ "$2" = --no-stdin=false ] && [ "$3" = '${runnerContainerId}' ] || exit 76
  has runner-started && has runner-post-inspected || exit 79
  IFS= read -r token || exit 74; IFS= read -r registration || exit 75
  if ctl runner-token-log; then printf '%s\n' "$token"; fi
  if ctl runner-result-token; then printf '%s' "$registration" >"$STATE/runner-result-secret"; fi
  context=$(/bin/cat "$STATE/runner-context")
  ctl e2e-drift && chmod 700 "$context/package.json"
  ctl e2e-config-drift && chmod 700 "$context/playwright.browser.config.ts"
  ctl e2e-dependency-drift && printf 'drift\n' >"$context/node_modules/fake/drift"
  ctl runner-timeout && sleep 5
  ctl runner-attach-fail && exit 73
  printf 'browser suite passed\n'; exit 0
fi
if [ "$1" = wait ]; then
  [ "$#" = 2 ] && [ "$2" = '${runnerContainerId}' ] || exit 76
  has runner-started || exit 79
  ctl runner-wait-fail && exit 73
  ctl runner-wait-timeout && sleep 5
  ctl runner-fail && printf '42\n' || printf '0\n'
  exit 0
fi
if [ "$1" = cp ]; then
  [ "$2" = '${runnerContainerId}:/tmp/e2e-results/.' ] || exit 76
  if ctl runner-result-token; then /bin/cat "$STATE/runner-result-secret"; else printf 'safe-result-archive'; fi
  exit 0
fi
if [ "$1" = rm ] && [ "$2" = -f ]; then
  [ "$3" = '${runnerContainerId}' ] || exit 76
  rm -f "$STATE/runner-id" "$STATE/runner-started" "$STATE/runner-pre-inspected" "$STATE/runner-post-inspected"
  ctl runner-name-substituted || rm -f "$STATE/runner"
  exit 0
fi
if [ "$1" = exec ]; then printf '1000\n'; exit; fi
if [ "$1" = inspect ]; then
  if [ "$2" != --format ]; then case "$2" in '${runnerContainerId}') has runner-id;; *-e2e-*) has runner;; *) has container;; esac; exit; fi
  if [ "$3" = '{{.Id}}' ]; then
    case "$4" in
      '${runnerContainerId}')
        [ -f "$STATE/runner-id" ] && /bin/cat "$STATE/runner-id"
        exit 0
        ;;
      *-e2e-*)
        if ctl runner-name-substituted; then
          printf '%s\n' '${"e".repeat(64)}'
        elif [ -f "$STATE/runner-name" ] && [ -f "$STATE/runner-id" ]; then
          /bin/cat "$STATE/runner-id"
        fi
        exit 0
        ;;
    esac
    exit 0
  fi
  if [ "$4" = '${runnerContainerId}' ]; then
    started=0; has runner-started && started=1
    post=0; case "$3" in *'"State"'*) post=1;; esac
    [ "$post" = "$started" ] || exit 79
    node -e '
      const fs=require("node:fs"),s=process.argv[1],post=process.argv[2]==="1";
      const get=n=>fs.readFileSync(s+"/runner-"+n,"utf8"),ctl=n=>fs.existsSync(s+"/control-"+n);
      const [uid,gid]=get("user").split(":").map(Number),p=fs.readFileSync(s+"/project","utf8"),r=get("revision");
      const name=get("name"),url=get("url"),ctx=get("context"),boot=get("bootstrap"),net=p+"_default";
      const hm=[{Type:"bind",Source:ctx,Target:"/workspace",ReadOnly:true},{Type:"bind",Source:boot,Target:"/runner-bootstrap",ReadOnly:true}];
      const mounts=[{Type:"bind",Source:ctx,Destination:"/workspace",Mode:"ro",RW:false,Propagation:"rprivate"},{Type:"bind",Source:boot,Destination:"/runner-bootstrap",Mode:"ro",RW:false,Propagation:"rprivate"}];
      const opt=(mode,size)=>"rw,nosuid,nodev,noexec,mode="+mode+",size="+size+",uid="+uid+",gid="+gid;
      const h={Binds:null,CapDrop:["ALL"],DeviceRequests:null,Devices:[],IpcMode:"private",Init:true,LogConfig:{Type:"local",Config:{"max-file":"1","max-size":"4m"}},Memory:2147483648,MemorySwap:2147483648,Mounts:hm,NanoCpus:2000000000,NetworkMode:net,PidMode:"",PidsLimit:512,PortBindings:{},Privileged:false,ReadonlyRootfs:true,RestartPolicy:{Name:"no"},SecurityOpt:["no-new-privileges:true"],ShmSize:536870912,Tmpfs:{"/home/wmux":opt("700",134217728),"/tmp":opt("1777",536870912),"/run":opt("755",8388608)},UsernsMode:"",VolumesFrom:null};
      const labels={"org.opencontainers.image.revision":r,"wmux.staging.e2e":"true","wmux.staging.project":p};
      const env=["PATH=/usr/bin:/bin","PLAYWRIGHT_BROWSERS_PATH=/ms-playwright","HOME=/home/wmux","TMPDIR=/tmp","XDG_CACHE_HOME=/home/wmux/.cache","WMUX_BUILD_REVISION="+r,"WMUX_E2E_BASE_URL="+url];
      const early=ctl("runner-prestart-network-realized");
      let networkId=post||early?"${networkId}":"";
      if(!post&&ctl("runner-prestart-network-drift"))networkId="${"f".repeat(64)}";
      const value={Id:"${runnerContainerId}",Image:"${runnerImageId}",Name:"/"+name,Config:{Cmd:["run"],Entrypoint:["/runner-bootstrap"],Env:env,Image:"${runnerImage}",Labels:labels,OpenStdin:true,StdinOnce:true,Tty:false,User:get("user"),WorkingDir:"/workspace"},HostConfig:h,NetworkSettings:{Networks:{[net]:{NetworkID:networkId}},Ports:{}},Mounts:mounts};
      if(post)value.State={Dead:false,Error:"",ExitCode:0,FinishedAt:"0001-01-01T00:00:00Z",OOMKilled:false,Paused:false,Pid:1234,Restarting:false,Running:true,StartedAt:"2026-08-05T12:00:00.000000000Z",Status:"running"};
      if(ctl("runner-inspect-privileged"))h.Privileged=true;
      if(ctl("runner-inspect-host-pid"))h.PidMode="host";
      if(ctl("runner-inspect-device"))h.Devices=[{PathOnHost:"/dev/null"}];
      if(ctl("runner-inspect-mount")){h.Mounts.push({Type:"bind",Source:"/etc",Target:"/host",ReadOnly:true});mounts.push({Type:"bind",Source:"/etc",Destination:"/host",Mode:"ro",RW:false,Propagation:"rprivate"});}
      if(ctl("runner-inspect-network"))value.NetworkSettings.Networks.extra={NetworkID:"${networkId}"};
      if(ctl("runner-inspect-port")){h.PortBindings={"8080/tcp":[{HostIp:"0.0.0.0",HostPort:"8080"}]};value.NetworkSettings.Ports={"8080/tcp":[{HostIp:"0.0.0.0",HostPort:"8080"}]};}
      if(ctl("runner-inspect-limit"))h.PidsLimit=1024;
      if(ctl("runner-inspect-token-env"))env.push("WMUX_E2E_TOKEN=metadata-secret");
      if(post&&ctl("runner-post-inspect-identity"))value.Name="/substituted";
      if(post&&ctl("runner-post-inspect-config"))value.Config.OpenStdin=false;
      if(post&&ctl("runner-post-inspect-stdin-once"))value.Config.StdinOnce=false;
      if(post&&ctl("runner-post-inspect-mount"))mounts[0].Source="/substituted";
      if(post&&ctl("runner-post-inspect-resource"))h.Memory=0;
      if(post&&ctl("runner-post-inspect-network"))value.NetworkSettings.Networks[net].NetworkID="";
      if(post&&ctl("runner-post-inspect-state"))value.State.Running=false;
      process.stdout.write(JSON.stringify(value));
    ' "$STATE" "$post"
    if [ "$post" = 0 ]; then touch "$STATE/runner-pre-inspected"; else touch "$STATE/runner-post-inspected"; fi
    exit
  fi
  case "$3" in *State.Health.Status*) printf 'healthy\n';; *'{{.Image}}'*) printf '${imageId}\n';; *'"HostConfig"'*)
    node -e 'const [cid,nid,iid,p,r,host,port,portMode]=process.argv.slice(1);const binding=[{HostIp:host,HostPort:port}];const h={Binds:null,CapDrop:["ALL"],DeviceRequests:null,Devices:[],IpcMode:"private",LogConfig:{Type:"local",Config:{"max-file":"3","max-size":"10m"}},Memory:1073741824,MemorySwap:1073741824,NanoCpus:2000000000,NetworkMode:p+"_default",PidMode:"",PidsLimit:512,PortBindings:{"3478/tcp":binding},Privileged:false,ReadonlyRootfs:true,RestartPolicy:{Name:"no"},SecurityOpt:["no-new-privileges:true"],Tmpfs:{"/home/node/.wmux":"rw,nosuid,nodev,mode=700,size=268435456,uid=1000,gid=1000","/tmp":"rw,nosuid,nodev,noexec,mode=1777,size=67108864,uid=1000,gid=1000","/run":"rw,nosuid,nodev,noexec,mode=755,size=8388608,uid=1000,gid=1000"},VolumesFrom:null};process.stdout.write(JSON.stringify({Id:cid,Image:iid,Name:"/"+p+"-wmux",Config:{Image:"wmux-staging:"+r,Labels:{"com.docker.compose.project":p,"com.docker.compose.service":"wmux","org.opencontainers.image.revision":r},User:"node"},HostConfig:h,NetworkSettings:{Networks:{[p+"_default"]:{NetworkID:nid}},Ports:portMode==="null"?null:{"3478/tcp":binding}},Mounts:[]}))' "$cid" "$nid" "$iid" "$project" "$revision" "$host" "$port" "$(ctl null-realized-ports && printf null || printf bound)";; esac; exit
fi
if [ "$1 $2" = 'network inspect' ]; then if [ "$3" != --format ]; then has network; exit; fi; if ctl runner-network-before-start-drift && has runner-pre-inspected; then nid='${"f".repeat(64)}'; fi; printf '{"Attachable":false,"Driver":"bridge","Id":"%s","Internal":false,"Labels":{"com.docker.compose.project":"%s","com.docker.compose.network":"default"},"Name":"%s_default","Options":{}}\n' "$nid" "$project" "$project"; exit; fi
if [ "$1 $2" = 'image inspect' ]; then printf '{"Id":"${imageId}","Labels":{"org.opencontainers.image.revision":"%s"}}\n' "$revision"; exit; fi
exit 72
`);
  executable(path.join(bin, "npm"), `#!/bin/sh
[ "$*" = 'ci --ignore-scripts --no-audit --no-fund' ] || exit 90
[ -z "\${WMUX_TOKEN-}\${WMUX_REGISTRATION_TOKEN-}\${WMUX_E2E_TOKEN-}\${WMUX_E2E_REGISTRATION_TOKEN-}\${WMUX_E2E_BASE_URL-}" ] || exit 91
[ -f package.json ] && [ -f package-lock.json ] || exit 92
printf 'npm-ci cwd=%s token=no reg=no\n' "$PWD" >>'${log}'
mkdir -p node_modules/.bin node_modules/fake node_modules/@playwright/test node_modules/playwright node_modules/playwright-core
for package in node_modules/@playwright/test node_modules/playwright node_modules/playwright-core; do printf '{"version":"1.61.0"}\n' >"$package/package.json"; done
[ ! -f '${state}/control-playwright-version-drift' ] || printf '{"version":"1.60.0"}\n' >node_modules/playwright-core/package.json
[ ! -f '${state}/control-e2e-symlink-drift' ] || { rm package.json; ln -s /etc/passwd package.json; }
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

const runRaw = (fixture: Fixture, command: string, changes: NodeJS.ProcessEnv = {}) => spawnSync("/bin/sh", [fixture.script, command], {
  cwd: os.tmpdir(), env: { ...fixture.environment, ...changes }, encoding: "utf8", timeout: 30_000,
});

const startHttpFixture = (directory: string, mode: string, port: string): ChildProcess => {
  const server = path.join(directory, `server-${mode}.mjs`);
  fs.writeFileSync(server, `import http from 'node:http';const mode=process.argv[2];http.createServer((req,res)=>{if(mode==='slow')return;if(mode==='redirect'){res.writeHead(302,{location:'/elsewhere'});return res.end();}if(mode==='endless'){res.writeHead(200,{'content-type':'application/json'});return setInterval(()=>res.write(' '),100);}if(mode==='oversized'){res.writeHead(200,{'content-type':'application/json'});return res.end('x'.repeat(300000));}res.writeHead(200,{'content-type':'application/json'});res.end(req.url==='/api/health'?'{"ok":true}':'{"settings":{"groupSidebarSessionsByHost":true}}')}).listen(Number(process.argv[3]),'0.0.0.0');`);
  const child = spawn(process.execPath, [server, mode, port], { stdio: "ignore" });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  return child;
};

const replaceSudo = (fixture: Fixture, scriptSource: string) => {
  const sudo = path.join(fixture.bin, "sudo");
  executable(sudo, scriptSource);
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

test("sudo docker-config cleanup uses /bin/rm without policy execution and clears lock+marker", () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(path.join(fixture.state, "control-sudo-only"), "");
    fs.writeFileSync(path.join(fixture.state, "control-sudo-artifacts"), "");
    const up = run(fixture, "up");
    assert.equal(up.status, 0, up.stderr);
    const runtimeDirectory = path.join(fixture.runtime, fixture.project);
    const lockDir = path.join(fixture.runtime, `.lock-${fixture.project}`);
    const dockerConfig = path.join(lockDir, "docker-config");
    const marker = path.join(lockDir, ".docker-sudo-used");
    const chown = spawnSync("sudo", ["-n", "chown", "-R", "0:0", dockerConfig], { encoding: "utf8" });
    if (chown.status !== 0) return;
    const script = `#!/bin/sh\n` +
      `[ "$1" = -n ] && shift\n` +
      `[ "$1" = env ] || exit 81\n` +
      `shift\n` +
      `while [ $# -gt 0 ] && [ "${"${1#-}"}" != "${"$1"}" ]; do\n` +
      `  [ "$1" = -i ] || exit 82\n` +
      `  shift\n` +
      `done\n` +
      `case " $* " in *\' remove-docker-config-tree \'*) exit 91;; esac\n` +
      `exec env -i WMUX_TEST_SUDO=1 "$@"\n`;
    replaceSudo(fixture, script);
    const down = runRaw(fixture, "down");
    assert.equal(down.status, 0, down.stderr);
    assert.equal(down.stdout.includes("already down"), false);
    assert.equal(fs.existsSync(lockDir), false, `lock directory should be removed on successful cleanup\n${down.stderr}`);
    assert.equal(fs.existsSync(marker), false, `marker should be removed on successful cleanup\n${down.stderr}`);
    assert.equal(fs.existsSync(dockerConfig), false, `docker config should be removed\n${down.stderr}`);
    assert.equal(fs.existsSync(runtimeDirectory), false, `runtime dir should be removed\n${down.stderr}`);
  } finally {
    removeFixture(fixture);
  }
});

test("failed sudo docker-config cleanup preserves lock and marker", () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(path.join(fixture.state, "control-sudo-only"), "");
    fs.writeFileSync(path.join(fixture.state, "control-sudo-artifacts"), "");
    const up = run(fixture, "up");
    assert.equal(up.status, 0, up.stderr);
    const runtimeDirectory = path.join(fixture.runtime, fixture.project);
    const lockDir = path.join(fixture.runtime, `.lock-${fixture.project}`);
    const dockerConfig = path.join(lockDir, "docker-config");
    const marker = path.join(lockDir, ".docker-sudo-used");
    const chown = spawnSync("sudo", ["-n", "chown", "-R", "0:0", dockerConfig], { encoding: "utf8" });
    if (chown.status !== 0) return;
    const script = `#!/bin/sh\n` +
      `[ "$1" = -n ] && shift\n` +
      `[ "$1" = env ] || exit 81\n` +
      `shift\n` +
      `while [ $# -gt 0 ] && [ "${"${1#-}"}" != "${"$1"}" ]; do\n` +
      `  [ "$1" = -i ] || exit 82\n` +
      `  shift\n` +
      `done\n` +
      `case " $* " in *\' /bin/rm \'*) exit 92;; esac\n` +
      `exec env -i WMUX_TEST_SUDO=1 "$@"\n`;
    replaceSudo(fixture, script);
    const down = runRaw(fixture, "down");
    assert.notEqual(down.status, 0);
    assert.equal(fs.existsSync(runtimeDirectory), true, "runtime directory should remain for retry\n" + down.stderr);
    assert.equal(fs.existsSync(lockDir), true, "lock directory should remain after failed cleanup\n" + down.stderr);
    assert.equal(fs.existsSync(marker), true, "marker should be preserved on failed cleanup\n" + down.stderr);
    assert.equal(fs.existsSync(dockerConfig), true, "docker config should remain for retry\n" + down.stderr);
  } finally {
    removeFixture(fixture);
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

test("owner-local E2E context rejects source/dependency drift and runs only in the isolated container", () => {
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
    const e2eContext = path.join(fixture.runtime, fixture.project, "e2e-context");
    const escapedContext = e2eContext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(log, new RegExp(`npm-ci cwd=${escapedContext} token=no reg=no`));
    assert.match(log, /<create> <--interactive>.*<--read-only>.*<--cap-drop> <ALL>.*<--network>.*_default/s);
    assert.match(log, new RegExp(`<start> <${runnerContainerId}>`));
    assert.match(log, new RegExp(`<attach> <--no-stdin=false> <${runnerContainerId}>`));
    assert.match(log, new RegExp(`<wait> <${runnerContainerId}>`));
    const startAt = log.indexOf(`<start> <${runnerContainerId}>`);
    const postInspectAt = log.indexOf(`<inspect> <--format>`, startAt + 1);
    const attachAt = log.indexOf(`<attach> <--no-stdin=false> <${runnerContainerId}>`);
    const waitAt = log.indexOf(`<wait> <${runnerContainerId}>`);
    assert.ok(startAt >= 0 && postInspectAt > startAt && attachAt > postInspectAt && waitAt > attachAt, log);
    assert.match(fs.readFileSync(path.join(fixture.runtime, fixture.project, "e2e-run.log"), "utf8"), /browser suite passed/);
    assert.equal(fs.existsSync(path.join(fixture.state, "canonical-playwright-executed")), false);
    assert.equal(fs.existsSync(path.join(identity.WMUX_WORKTREE, "node_modules")), false);
    assert.equal(fs.existsSync(e2eContext), false);
    assert.equal(fs.existsSync(path.join(fixture.state, "runner")), false);
    assert.doesNotMatch(log, /WMUX_TOKEN=|WMUX_REGISTRATION_TOKEN=/);
    assert.equal(log.includes(secrets.WMUX_TOKEN), false); assert.equal(log.includes(secrets.WMUX_REGISTRATION_TOKEN), false);
    assert.equal(run(fixture, "down").status, 0);
  } finally { server?.kill(); removeFixture(fixture); }
});

test("runner rejects image, package, inspect, output, result, and execution drift with exact cleanup", () => {
  const fixture = makeFixture();
  let server: ChildProcess | undefined;
  try {
    assert.equal(run(fixture, "up").status, 0);
    server = startHttpFixture(fixture.directory, "ok", fixture.port);
    const runtimeDirectory = path.join(fixture.runtime, fixture.project);
    const secrets = metadata(path.join(runtimeDirectory, "staging.env"));
    fs.writeFileSync(path.join(fixture.state, "control-runner-image-optional-absent"), "");
    fs.writeFileSync(path.join(fixture.state, "control-runner-prestart-network-realized"), "");
    const absentOptional = run(fixture, "e2e");
    assert.equal(absentOptional.status, 0, absentOptional.stderr);
    fs.rmSync(path.join(fixture.state, "control-runner-image-optional-absent"));
    fs.rmSync(path.join(fixture.state, "control-runner-prestart-network-realized"));
    for (const control of [
      "runner-image-drift", "runner-image-malformed", "runner-image-unexpected", "playwright-version-drift", "e2e-symlink-drift", "runner-inspect-privileged", "runner-inspect-host-pid",
      "runner-inspect-device", "runner-inspect-mount", "runner-inspect-network", "runner-inspect-port",
      "runner-inspect-limit", "runner-inspect-token-env", "runner-post-inspect-identity", "runner-post-inspect-config", "runner-post-inspect-stdin-once",
      "runner-post-inspect-mount", "runner-post-inspect-resource", "runner-post-inspect-network", "runner-post-inspect-state",
      "runner-prestart-network-drift", "runner-network-before-start-drift", "runner-start-fail", "runner-attach-fail",
      "runner-wait-fail", "runner-token-log", "runner-result-token", "runner-fail",
    ]) {
      const controlPath = path.join(fixture.state, `control-${control}`); fs.writeFileSync(controlPath, "");
      const priorLogSize = fs.statSync(fixture.log).size;
      const result = run(fixture, "e2e");
      assert.notEqual(result.status, 0, `${control} unexpectedly passed`);
      assert.equal(fs.existsSync(path.join(fixture.state, "runner")), false, `${control} left runner container state`);
      assert.equal(fs.existsSync(path.join(runtimeDirectory, "e2e-context")), false, `${control} left E2E context`);
      assert.equal(fs.existsSync(path.join(fixture.runtime, `.lock-${fixture.project}`)), false, `${control} left operation lock`);
      assert.equal(result.stderr.includes(secrets.WMUX_TOKEN), false, `${control} reported shared token`);
      assert.equal(result.stderr.includes(secrets.WMUX_REGISTRATION_TOKEN), false, `${control} reported registration token`);
      const operationLog = fs.readFileSync(fixture.log, "utf8").slice(priorLogSize);
      if (/^(?:runner-(?:image|inspect|prestart|network-before-start|post-inspect|start-fail)|playwright-version|e2e-symlink)/.test(control)) {
        assert.doesNotMatch(operationLog, /<attach>/, `${control} delivered credentials before policy validation completed`);
      }
      if (control === "runner-network-before-start-drift") assert.doesNotMatch(operationLog, /<start>/);
      fs.rmSync(controlPath);
    }
    const commandLog = fs.readFileSync(fixture.log, "utf8");
    assert.equal(commandLog.includes(secrets.WMUX_TOKEN), false);
    assert.equal(commandLog.includes(secrets.WMUX_REGISTRATION_TOKEN), false);
    assert.doesNotMatch(commandLog, /<--env> <WMUX_E2E_(?:TOKEN|REGISTRATION_TOKEN)=/);
    assert.equal(run(fixture, "down").status, 0);
  } finally { server?.kill(); removeFixture(fixture); }
});

test("bounded runner attach and wait time out without putting credentials in arguments or logs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-runner-timeout-")); fs.chmodSync(directory, 0o700);
  const lock = path.join(directory, ".lock-wmux-staging-timeout"); const config = path.join(lock, "docker-config");
  const bin = path.join(directory, "bin"); const envFile = path.join(directory, "staging.env"); const logFile = path.join(directory, "e2e-run.log");
  fs.mkdirSync(config, { recursive: true, mode: 0o700 }); fs.chmodSync(config, 0o500); fs.mkdirSync(bin, { mode: 0o700 });
  const token = "a".repeat(64); const registration = "b".repeat(64);
  fs.writeFileSync(envFile, `WMUX_TOKEN=${token}\nWMUX_REGISTRATION_TOKEN=${registration}\n`, { mode: 0o600 });
  try {
    for (const phase of ["attach", "wait"]) {
      executable(path.join(bin, "docker"), `#!/bin/sh
[ "$3" != "${phase}" ] || sleep 5
[ "$3" != wait ] || printf '0\\n'
`);
      const started = Date.now();
      const result = spawnSync(process.execPath, [sourcePolicy, "run-runner", envFile, logFile, "1", "direct", config, "context", "default", runnerContainerId], {
        encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: process.env.HOME }, timeout: 5_000,
      });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /bounded timeout/); assert.ok(Date.now() - started < 4_000);
      assert.equal(result.stderr.includes(token) || result.stderr.includes(registration), false);
      if (fs.existsSync(logFile)) {
        const log = fs.readFileSync(logFile, "utf8"); assert.equal(log.includes(token) || log.includes(registration), false);
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("runner timeout removes only the exact runner, E2E context, and operation lock", () => {
  const fixture = makeFixture({ runnerTimeoutSeconds: 1 });
  let server: ChildProcess | undefined;
  try {
    assert.equal(run(fixture, "up").status, 0);
    server = startHttpFixture(fixture.directory, "ok", fixture.port);
    fs.writeFileSync(path.join(fixture.state, "control-runner-timeout"), "");
    const result = run(fixture, "e2e");
    assert.notEqual(result.status, 0); assert.match(result.stderr, /bounded timeout|browser E2E runner failed/);
    assert.equal(fs.existsSync(path.join(fixture.state, "runner")), false);
    assert.equal(fs.existsSync(path.join(fixture.runtime, fixture.project, "e2e-context")), false);
    assert.equal(fs.existsSync(path.join(fixture.runtime, `.lock-${fixture.project}`)), false);
    const log = fs.readFileSync(fixture.log, "utf8");
    assert.match(log, /<rm> <-f> <[0-9a-f]{64}>/);
    assert.doesNotMatch(log, /\bprune\b|container rm|--force .*wmux-staging/);
    fs.rmSync(path.join(fixture.state, "control-runner-timeout"));
    assert.equal(run(fixture, "down").status, 0);
  } finally { server?.kill(); removeFixture(fixture); }
});

test("create failure does not retain runner_created and does not perform by-name cleanup", () => {
  const fixture = makeFixture();
  let server: ChildProcess | undefined;
  try {
    assert.equal(run(fixture, "up").status, 0);
    server = startHttpFixture(fixture.directory, "ok", fixture.port);
    fs.writeFileSync(path.join(fixture.state, "control-runner-create-fail"), "");
    const result = run(fixture, "e2e");
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.includes("cannot create isolated E2E runner"), true);
    assert.equal(fs.existsSync(path.join(fixture.runtime, ".lock-" + fixture.project)), false);
    assert.equal(fs.existsSync(path.join(fixture.state, "runner")), false);
    const log = fs.readFileSync(fixture.log, "utf8");
    assert.doesNotMatch(log, /<rm> <-f>/);
  } finally {
    server?.kill();
    removeFixture(fixture);
  }
});

test("name substitution during runner cleanup fails and retains lock for operator attention", () => {
  const fixture = makeFixture();
  let server: ChildProcess | undefined;
  try {
    assert.equal(run(fixture, "up").status, 0);
    server = startHttpFixture(fixture.directory, "ok", fixture.port);
    fs.writeFileSync(path.join(fixture.state, "control-runner-name-substituted"), "");
    const result = runRaw(fixture, "e2e");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /operation lock retained/);
    assert.equal(fs.existsSync(path.join(fixture.runtime, `.lock-${fixture.project}`)), true);
    const log = fs.readFileSync(fixture.log, "utf8");
    assert.match(log, /<rm> <-f> <[0-9a-f]{64}>/);
    assert.equal(fs.existsSync(path.join(fixture.state, "runner")), true);
  } finally {
    server?.kill();
    removeFixture(fixture);
  }
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
  const bootstrap = fs.readFileSync(path.join(sourceRoot, "deploy/docker/e2e-runner-bootstrap"), "utf8");
  assert.match(compose, /WMUX_PUBLISH_HOST.*WMUX_PUBLISH_PORT/); assert.match(compose, /internal: false/); assert.match(compose, /attachable: false/);
  assert.doesNotMatch(compose, /^volumes:/m); assert.doesNotMatch(script, /docker-compose\.yml|--volumes|\bprune\b|git archive|candidate\.tar/);
  assert.match(script, /runtime_root=\$\{XDG_STATE_HOME:-\$\{HOME:\?HOME is required\}\/\.local\/state\}\/wmux\/docker-staging/);
  assert.doesNotMatch(script, /\.workspace\/deployments\/wmux-staging/);
  assert.match(script, /git_cmd pack-objects --stdout --revs <"\$object_revs" >"\$object_pack"/);
  assert.match(script, /isolated_git index-pack --stdin <"\$object_pack"/);
  assert.match(script, /create-build-context.*"\$candidate_context".*"\$build_context"/);
  assert.match(script, /-f "\$build_context\/deploy\/docker\/docker-compose\.staging\.yml"/);
  assert.doesNotMatch(script, /pack-objects "\$isolated_repo\/objects\/pack\/pack"/);
  assert.doesNotMatch(script, /(?:^|[;|&]\s*|\n\s*)(?:tar|cp)\s/m);
  assert.match(script, /scan-runner-results/); assert.match(policy, /\["cp", `\$\{containerId\}:\/tmp\/e2e-results/);
  assert.doesNotMatch(policy, /spawnSync\("(?:tar|cp)"/);
  assert.match(policy, /validateCommittedTree/); assert.match(policy, /O_EXCL/); assert.match(policy, /O_NOFOLLOW/);
  assert.match(policy, /validateCleanupWorktree/); assert.match(policy, /"worktree", "remove", "--force"/);
  assert.match(bootstrap, /read -r WMUX_E2E_TOKEN/); assert.match(bootstrap, /read -r WMUX_E2E_REGISTRATION_TOKEN/);
  assert.match(bootstrap, /if IFS= read -r _unexpected/);
  assert.match(bootstrap, /exec \/workspace\/node_modules\/\.bin\/playwright test/);
  assert.match(bootstrap, /--workers=1 --output=\/tmp\/e2e-results/);
  assert.doesNotMatch(bootstrap, /set -x|docker|WMUX_E2E_BASE_URL=/);
});
