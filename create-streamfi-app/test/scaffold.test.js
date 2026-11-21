const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_TEMPLATE,
  BUNDLED_TEMPLATE_DIR,
  TEMPLATES_DIR,
  SDK_PACKAGE,
  BUILT_IN_TEMPLATES,
  parseArguments,
  scaffold,
  testnetEnv,
} = require("../lib/scaffold");

test("parses a project name and defaults", () => {
  assert.deepEqual(parseArguments(["my-app"]), {
    projectName: "my-app",
    template: DEFAULT_TEMPLATE,
    skipInstall: false,
    help: false,
    hooks: false,
  });
});

test("parses built-in template name", () => {
  assert.deepEqual(parseArguments(["my-app", "--template", "node-script"]), {
    projectName: "my-app",
    template: "node-script",
    skipInstall: false,
    help: false,
    hooks: false,
  });
});

test("parses template URL and skip-install options", () => {
  assert.deepEqual(
    parseArguments([
      "my-app",
      "--template",
      "https://example.test/template.git",
      "--skip-install",
    ]),
    {
      projectName: "my-app",
      template: "https://example.test/template.git",
      skipInstall: true,
      help: false,
      hooks: false,
    },
  );
});

test("rejects unknown built-in template name during scaffold", () => {
  assert.throws(
    () =>
      scaffold(
        {
          projectName: "my-app",
          template: "unknown-template",
          skipInstall: true,
          hooks: false,
        },
        {
          existsSync: () => false,
          resolve: (...parts) => parts.join("/"),
          writeFileSync: () => {},
          cpSync: () => {},
          run: () => {},
        },
      ),
    /Unknown template/,
  );
});

test("with an explicit --template, clones it and installs the SDK separately", () => {
  const calls = [];
  const writes = [];
  scaffold(
    {
      projectName: "my-app",
      template: "https://example.test/template.git",
      skipInstall: false,
    },
    {
      existsSync: () => false,
      resolve: (...parts) => parts.join("/"),
      writeFileSync: (...args) => writes.push(args),
      cpSync: () => {
        throw new Error(
          "cpSync should not be called for an explicit --template",
        );
      },
      run: (...args) => calls.push(args),
    },
  );

  assert.deepEqual(calls, [
    [
      "git",
      [
        "clone",
        "--depth",
        "1",
        "https://example.test/template.git",
        process.cwd() + "/my-app",
      ],
    ],
    ["npm", ["install"], { cwd: process.cwd() + "/my-app" }],
    ["npm", ["install", SDK_PACKAGE], { cwd: process.cwd() + "/my-app" }],
  ]);
  assert.deepEqual(writes, [
    [process.cwd() + "/my-app/.env.local", testnetEnv(), "utf8"],
  ]);
});

test("with --template node-script, copies the node-script template and installs once", () => {
  const calls = [];
  const copies = [];
  scaffold(
    { projectName: "my-app", template: "node-script", skipInstall: false },
    {
      existsSync: () => false,
      resolve: (...parts) => parts.join("/"),
      writeFileSync: () => {},
      cpSync: (...args) => copies.push(args),
      run: (...args) => calls.push(args),
    },
  );

  assert.deepEqual(copies, [
    [
      TEMPLATES_DIR + "/node-script",
      process.cwd() + "/my-app",
      { recursive: true },
    ],
  ]);
  assert.deepEqual(calls, [
    ["npm", ["install"], { cwd: process.cwd() + "/my-app" }],
  ]);
});

test("with no --template, copies the bundled next-app template and installs once", () => {
  const calls = [];
  const writes = [];
  const copies = [];
  scaffold(
    { projectName: "my-app", template: DEFAULT_TEMPLATE, skipInstall: false },
    {
      existsSync: () => false,
      resolve: (...parts) => parts.join("/"),
      writeFileSync: (...args) => writes.push(args),
      cpSync: (...args) => copies.push(args),
      run: (...args) => calls.push(args),
    },
  );

  assert.deepEqual(copies, [
    [BUNDLED_TEMPLATE_DIR, process.cwd() + "/my-app", { recursive: true }],
  ]);
  assert.ok(
    testnetEnv("next-app").includes("NEXT_PUBLIC_NETWORK"),
    "next-app env uses NEXT_PUBLIC_NETWORK",
  );
  assert.ok(
    testnetEnv("node-script").includes("STREAM_NETWORK"),
    "node-script env uses STREAM_NETWORK",
  );
  // No separate `npm install <SDK_PACKAGE>` — the bundled template already
  // declares it as a dependency.
  assert.deepEqual(calls, [
    ["npm", ["install"], { cwd: process.cwd() + "/my-app" }],
  ]);
  assert.deepEqual(writes, [
    [process.cwd() + "/my-app/.env.local", testnetEnv(), "utf8"],
  ]);
});

test("testnetEnv() emits the variable names the scaffolded app actually reads", () => {
  const env = testnetEnv();
  assert.match(env, /^NEXT_PUBLIC_NETWORK=testnet$/m);
  assert.match(env, /^FACTORY_ADDRESS=$/m);
  assert.match(env, /^STELLAR_SECRET=$/m);
  assert.match(env, /^NEXT_PUBLIC_ADDRESS=$/m);
  // The old, never-read variable names must be gone.
  assert.doesNotMatch(env, /NEXT_PUBLIC_STELLAR_NETWORK/);
  assert.doesNotMatch(env, /NEXT_PUBLIC_STELLAR_RPC_URL/);
  assert.doesNotMatch(env, /NEXT_PUBLIC_STELLAR_HORIZON_URL/);
});

test("rejects an existing target directory", () => {
  assert.throws(
    () =>
      scaffold(
        {
          projectName: "my-app",
          template: DEFAULT_TEMPLATE,
          skipInstall: true,
        },
        {
          existsSync: () => true,
          resolve: (...parts) => parts.join("/"),
          writeFileSync: () => {},
          cpSync: () => {},
          run: () => {},
        },
      ),
    /already exists/,
  );
});

test("parses --hooks flag", () => {
  assert.deepEqual(parseArguments(["my-app", "--hooks"]), {
    projectName: "my-app",
    template: DEFAULT_TEMPLATE,
    skipInstall: false,
    help: false,
    hooks: true,
  });
});

test("with --hooks, copies the hooks template and installs once", () => {
  const calls = [];
  const copies = [];
  scaffold(
    {
      projectName: "my-app",
      template: DEFAULT_TEMPLATE,
      skipInstall: false,
      hooks: true,
    },
    {
      existsSync: () => false,
      resolve: (...parts) => parts.join("/"),
      writeFileSync: () => {},
      cpSync: (...args) => copies.push(args),
      run: (...args) => calls.push(args),
    },
  );

  assert.deepEqual(copies, [
    [TEMPLATES_DIR + "/hooks", process.cwd() + "/my-app", { recursive: true }],
  ]);
  assert.deepEqual(calls, [
    ["npm", ["install"], { cwd: process.cwd() + "/my-app" }],
  ]);
});
