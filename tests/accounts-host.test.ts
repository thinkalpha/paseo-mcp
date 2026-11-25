/**
 * The Accounts plugin's homes, against a sandbox HOME. Accounts registers
 * managed homes under its own registry (state.json): each Claude home keeps
 * its real .claude.json, each Codex home keeps its real auth.json but points
 * its config.toml at the main home's config.toml — one shared settings file,
 * several accounts. Connectors discovers those homes from the registry,
 * labels them by registry name, writes the shared file once (one backup,
 * every account over it reported), and never touches auth: each account is
 * asked about sign-in in its own home, whatever files it shares.
 */
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const home = mkdtempSync(join(tmpdir(), "paseo-mcp-accounts-"));
process.env.HOME = home;
process.env.PASEO_HOME = join(home, ".paseo");
delete process.env.AGENT_LINK_HOME;
delete process.env.AGENT_AUTH_HOME;

const claudePath = join(home, ".claude.json");
const codexPath = join(home, ".codex", "config.toml");
const registryPath = join(home, ".paseo", "paseo-accounts", "state.json");
const homesRoot = join(home, ".paseo", "paseo-accounts", "homes");
const claudeManaged = join(homesRoot, "claude-aaaa");
const codexSharedA = join(homesRoot, "codex-bbbb");
const codexSharedB = join(homesRoot, "codex-cccc");
const codexDetached = join(homesRoot, "codex-dddd");
const legacyClaude = join(home, ".agent-link", "accounts", "claude", "legacy@example.com");
const externalCodex = join(home, ".codex-accounts", "somewhere@example.com");

const CLAUDE_MAIN = {
  oauthAccount: { emailAddress: "david@example.com" },
  mcpServers: {
    primary: { type: "stdio", command: "primary-mcp" },
    shared: { type: "http", url: "https://shared.example/mcp" },
  },
  projects: { "/code/demo": { hasTrustDialogAccepted: true } },
};

const CODEX_MAIN = [
  "[mcp_servers.alpha]",
  'command = "alpha-mcp"',
  "",
  "[mcp_servers.beta]",
  'url = "https://beta.example/mcp"',
  "",
].join("\n");

/** A Codex auth.json carrying only an id_token whose payload says one email. */
function authJson(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email }), "utf8").toString("base64url");
  return JSON.stringify({ tokens: { id_token: `header.${payload}.signature` } });
}

function setup(): void {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(claudePath, JSON.stringify(CLAUDE_MAIN, null, 2));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(codexPath, CODEX_MAIN);
  writeFileSync(join(home, ".codex", "auth.json"), authJson("david@example.com"));

  // One managed Claude home: its own .claude.json, one of its own servers,
  // and a sign-in still pending for the primary's `primary` server.
  mkdirSync(claudeManaged, { recursive: true });
  writeFileSync(
    join(claudeManaged, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "maya@example.com" }, mcpServers: { own: { type: "stdio", command: "own-mcp" } } }, null, 2),
  );
  writeFileSync(join(claudeManaged, "mcp-needs-auth-cache.json"), JSON.stringify({ primary: "waiting for sign-in" }));

  // Two managed Codex homes that share the main config.toml, with real
  // per-account auth.json files saying the SAME email: identity is the home,
  // not the email. A third managed Codex home keeps its own real config.
  for (const dir of [codexSharedA, codexSharedB]) {
    mkdirSync(dir, { recursive: true });
    symlinkSync(codexPath, join(dir, "config.toml"));
    writeFileSync(join(dir, "auth.json"), authJson("david@example.com"));
  }
  mkdirSync(codexDetached, { recursive: true });
  writeFileSync(join(codexDetached, "config.toml"), '[mcp_servers.omega]\ncommand = "omega-mcp"\n');
  writeFileSync(join(codexDetached, "auth.json"), authJson("det@example.com"));

  // The legacy layouts: an agent-link slot named after its email, and an
  // external root whose config happens to be a symlink to the main one.
  mkdirSync(legacyClaude, { recursive: true });
  writeFileSync(
    join(legacyClaude, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "legacy@example.com" }, mcpServers: { "legacy-only": { type: "stdio", command: "legacy-mcp" } } }, null, 2),
  );
  mkdirSync(externalCodex, { recursive: true });
  symlinkSync(codexPath, join(externalCodex, "config.toml"));
  writeFileSync(join(externalCodex, "auth.json"), authJson("somewhere@example.com"));

  writeFileSync(
    registryPath,
    JSON.stringify(
      {
        version: 1,
        accounts: [
          { id: "claude-main", home: null, family: "claude", label: "david", email: "david@example.com" },
          { id: "claude-aaaa", home: claudeManaged, family: "claude", label: "Work Ultra", email: "maya@example.com" },
          { id: "codex-bbbb", home: codexSharedA, family: "codex", label: "THINKalpha 2", email: "david@example.com" },
          { id: "codex-cccc", home: codexSharedB, family: "codex", label: "THINKalpha 2", email: "david@example.com" },
          { id: "codex-dddd", home: codexDetached, family: "codex", label: "", email: "det@example.com" },
        ],
      },
      null,
      2,
    ),
  );
}

// The server modules capture the environment at load, so they are imported
// after the sandbox HOME is set — inside the tests, where the import is
// cached after the first call. The sandbox must be built before the first
// import: the agent-link root is picked at load, by which accounts exist.
async function load() {
  setup();
  const [handlers, copyAll, codexAuth, files] = await Promise.all([
    import("../server/handlers"),
    import("../server/copy-all"),
    import("../server/codex-auth"),
    import("../server/files"),
  ]);
  files.forgetAllFiles();
  codexAuth.resetCodexAuthForTests();
  return { handlers, copyAll, codexAuth, files };
}

const context = {
  paseo: { config: { get: async () => ({ config: { providers: {} } }), patch: async () => ({}) }, projects: { list: async () => [] } },
} as never;

function destId(labelPart: string, destinations: Array<{ label: string; id: string }>): string {
  const found = destinations.find((dest) => dest.label.includes(labelPart));
  assert.ok(found, `a destination like ${labelPart} exists`);
  return found!.id;
}

function backupCount(dir: string, baseName: string): number {
  try {
    return readdirSync(dir).filter((entry) => entry.startsWith(`${baseName}.bak-paseo-mcp-`)).length;
  } catch {
    return 0;
  }
}

test("managed rows come from the registry, labelled by registry name; the shared config is said as such", async () => {
  const { handlers } = await load();
  const matrix = await handlers.handleMcpMatrix({} as never, context);
  const labels = matrix.destinations.map((dest) => dest.label);
  assert.ok(labels.some((label) => label === "Claude · Work Ultra (Accounts)"), "managed claude, registry label");
  assert.ok(labels.filter((label) => label === "Codex · THINKalpha 2 (Accounts, shared config)").length === 2, "both shared codex homes, shared marker on each");
  assert.ok(labels.some((label) => label === "Codex · det@example.com (Accounts)"), "detached codex home: its own email, no shared marker");
  assert.ok(labels.some((label) => label === "Claude · legacy@example.com (slot)"), "legacy slot kept as before");
  assert.ok(labels.some((label) => label === "Codex · somewhere@example.com (slot)"), "external root kept as before");
});

test("an account with a duplicated label and email is still one row per home", async () => {
  const { handlers } = await load();
  const matrix = await handlers.handleMcpMatrix({} as never, context);
  const shared = matrix.destinations.filter((dest) => dest.label === "Codex · THINKalpha 2 (Accounts, shared config)");
  assert.equal(shared.length, 2, "one row per home, not per label");
  assert.notEqual(shared[0].id, shared[1].id);
  assert.ok(shared.every((dest) => dest.account === "david@example.com"), "the email is the credential's, not the registry's guess");
});

test("sign-in state is asked of each home; shared config, separate homes", async () => {
  const { handlers, codexAuth } = await load();
  const asked: string[] = [];
  codexAuth.setCodexRunnerForTests(async (dir) => {
    asked.push(dir);
    return { alpha: "connected", beta: "not-connected" };
  });
  const { accounts } = await handlers.handleMcpAuth({}, context);
  await codexAuth.codexChecksSettled();
  const codexHomes = accounts.filter((account) => account.provider === "codex").map((account) => account.dir);
  assert.deepEqual(codexHomes, [join(home, ".codex"), externalCodex, codexSharedA, codexSharedB, codexDetached], "primary, every managed home and the legacy slot, each its own row");
  assert.deepEqual(asked.sort(), [join(home, ".codex"), externalCodex, codexSharedA, codexSharedB, codexDetached].sort(), "Codex is asked in each account's own home");
  const maya = accounts.find((account) => account.provider === "claude" && account.dir === claudeManaged)!;
  assert.deepEqual(maya.needsAuth, ["primary"], "the managed claude home's own pending sign-in");
});

test("only:{dir} names one account; only:{email} names every home with that email", async () => {
  const { handlers } = await load();
  const byDir = handlers.collectAccounts({ askCodex: false, only: { provider: "codex", dir: codexSharedB } });
  assert.equal(byDir.length, 1, "the home picks its own account out of the duplicates");
  assert.equal(byDir[0].dir, codexSharedB);
  const byEmail = handlers.collectAccounts({ askCodex: false, only: { provider: "codex", email: "david@example.com" } });
  assert.equal(byEmail.length, 3, "primary and both shared homes carry that email");
  const all = handlers.collectAccounts({ askCodex: false });
  assert.equal(all.filter((account) => account.provider === "claude").length, 3, "no only: every claude account appears");
});

test("adding to three destinations over one shared file writes once, backs up once, reports three", async () => {
  const { handlers } = await load();
  const matrix = await handlers.handleMcpMatrix({} as never, context);
  const sharedIds = matrix.destinations.filter((dest) => dest.label === "Codex · THINKalpha 2 (Accounts, shared config)").map((dest) => dest.id);
  const result = await handlers.handleMcpAdd(
    { name: "gamma", kind: "stdio", command: "gamma-mcp", targets: [destId("Codex · david@example.com (primary)", matrix.destinations), sharedIds[0], sharedIds[1]] },
    context,
  );
  assert.ok(result.ok, result.message);
  for (const label of ["Codex · david@example.com (primary)", "Codex · THINKalpha 2 (Accounts, shared config), Codex · THINKalpha 2 (Accounts, shared config)"]) {
    assert.ok(result.message.includes(label), `reported: ${label}`);
  }
  assert.equal(backupCount(join(home, ".codex"), "config.toml"), 1, "one backup of the one physical file");
  const after = readFileSync(codexPath, "utf8");
  assert.ok(after.includes("[mcp_servers.gamma]"), "the shared file gained the server");
  assert.ok(lstatSync(join(codexSharedA, "config.toml")).isSymbolicLink(), "the account's link is still a link");
  assert.ok(lstatSync(join(codexSharedB, "config.toml")).isSymbolicLink(), "the account's link is still a link");
});

test("a managed home with its own config file is written directly, the main config untouched", async () => {
  const { handlers } = await load();
  const before = readFileSync(codexPath, "utf8");
  const matrix = await handlers.handleMcpMatrix({} as never, context);
  const result = await handlers.handleMcpAdd(
    { name: "gamma", kind: "stdio", command: "gamma-mcp", targets: [destId("det@example.com (Accounts)", matrix.destinations)] },
    context,
  );
  assert.ok(result.ok, result.message);
  assert.ok(result.message.includes("Codex · det@example.com (Accounts)"), result.message);
  assert.ok(readFileSync(join(codexDetached, "config.toml"), "utf8").includes("[mcp_servers.gamma]"), "written to the home's own file");
  assert.equal(readFileSync(codexPath, "utf8"), before, "the main config did not move");
});

test("an unregistered home whose config is a symlink to the main config is refused", async () => {
  const { handlers } = await load();
  const before = readFileSync(codexPath, "utf8");
  const matrix = await handlers.handleMcpMatrix({} as never, context);
  const result = await handlers.handleMcpAdd(
    { name: "gamma", kind: "stdio", command: "gamma-mcp", targets: [destId("somewhere@example.com (slot)", matrix.destinations)] },
    context,
  );
  assert.ok(!result.ok);
  assert.ok(result.message.includes("is a symbolic link, so paseo-mcp won't write through it"), result.message);
  assert.equal(readFileSync(codexPath, "utf8"), before, "the main config was not written through the unregistered link");
});

test("copy-all writes the shared file once, reports every account over it, and no shared write reads as skipped", async () => {
  const { handlers, copyAll } = await load();
  const matrix = await handlers.handleMcpMatrix({} as never, context);
  const codexIds = matrix.destinations.filter((dest) => dest.provider === "codex" && !dest.label.includes("(slot)")).map((dest) => dest.id);
  assert.equal(codexIds.length, 4, "primary, two shared homes and the detached home");
  const result = await copyAll.handleMcpCopyAll({ servers: [{ name: "primary", targets: codexIds }] }, context);
  assert.ok(result.ok, result.message);
  const primary = result.results[0];
  assert.equal(primary.written.length, 4, "every codex destination is reported, the shared file written once");
  assert.equal(backupCount(join(home, ".codex"), "config.toml"), 1, "one write to the shared file, one backup");
  assert.equal(backupCount(codexDetached, "config.toml"), 1, "the detached home got its own write");
  assert.ok(!primary.skipped.some((line) => line.reason === "it already has it"), "nothing mistaken for already present");
  assert.ok(readFileSync(join(codexDetached, "config.toml"), "utf8").includes("primary-mcp"), "the detached home's own file");
});

test("rename writes the shared file once and reports every account over it", async () => {
  const { handlers } = await load();
  const result = await handlers.handleMcpRename({ name: "alpha", newName: "alpha2" }, context);
  assert.ok(result.ok, result.message);
  assert.equal(result.message.match(/THINKalpha 2/g)?.length, 2, "both shared homes are named");
  assert.ok(result.message.includes("(primary)"), "the primary is named");
  const after = readFileSync(codexPath, "utf8");
  assert.ok(after.includes("[mcp_servers.alpha2]"), "renamed in the shared file");
  assert.ok(!after.includes("[mcp_servers.alpha]"), "the old block is gone");
});

test("remove through any destination over the shared file takes the server out once", async () => {
  const { handlers } = await load();
  const matrix = await handlers.handleMcpMatrix({} as never, context);
  const ids = [
    destId("Codex · david@example.com (primary)", matrix.destinations),
    ...matrix.destinations.filter((dest) => dest.label === "Codex · THINKalpha 2 (Accounts, shared config)").map((dest) => dest.id),
  ];
  const result = await handlers.handleMcpRemove({ name: "beta", targets: ids }, context);
  assert.ok(result.ok, result.message);
  assert.equal(result.removed.length, 3, "each destination over the file is reported");
  assert.ok(!readFileSync(codexPath, "utf8").includes("[mcp_servers.beta]"), "gone from the shared file");
});

test("sync brings the primary's servers to a managed Claude home, and leaves the shared Codex file byte-identical", async () => {
  const { handlers } = await load();
  const codexBefore = readFileSync(codexPath);
  const { ok, log } = await handlers.handleMcpSync();
  assert.ok(ok, log);
  const managed = JSON.parse(readFileSync(join(claudeManaged, ".claude.json"), "utf8"));
  assert.ok(managed.mcpServers.primary && managed.mcpServers.shared, "the primary's servers landed");
  assert.equal(managed.projects["/code/demo"].hasTrustDialogAccepted, true, "project trust copied");
  assert.ok(log.includes("claude · maya@example.com"), log);
  assert.ok(readFileSync(codexPath).equals(codexBefore), "the shared codex file already had everything: untouched");
});

test("with no registry there are no managed rows, and the legacy ones remain", async () => {
  const { handlers } = await load();
  rmSync(registryPath, { force: true });
  const matrix = await handlers.handleMcpMatrix({} as never, context);
  const labels = matrix.destinations.map((dest) => dest.label);
  assert.ok(!labels.some((label) => label.includes("(Accounts")), "no managed rows");
  assert.ok(labels.some((label) => label === "Claude · legacy@example.com (slot)"), "legacy slot intact");
  assert.ok(labels.some((label) => label === "Codex · somewhere@example.com (slot)"), "external slot intact");
});
