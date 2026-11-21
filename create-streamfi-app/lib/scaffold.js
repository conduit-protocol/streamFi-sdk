const { execFileSync } = require("node:child_process");
const { existsSync, writeFileSync, cpSync } = require("node:fs");
const { basename, resolve, join } = require("node:path");

// Bundled, StreamFi-wired Next.js template (a copy of examples/nextjs-app),
// used by default. Pass --template <name|url> to pick a different starter
// (next-app, node-script, cron-worker) or clone an external git repository.
const BUNDLED_TEMPLATE_DIR = join(__dirname, "..", "template");
const TEMPLATES_DIR = join(__dirname, "..", "templates");
// null means "use the bundled template"; parseArguments() only replaces this
// with a name/URL when the caller explicitly passes --template.
const DEFAULT_TEMPLATE = null;
const BUILT_IN_TEMPLATES = ["next-app", "node-script", "cron-worker"];
const SDK_PACKAGE = "@conduit-protocol/sdk";

function parseArguments(args) {
  const options = {
    template: DEFAULT_TEMPLATE,
    skipInstall: false,
    help: false,
    hooks: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--skip-install") options.skipInstall = true;
    else if (argument === "--hooks") options.hooks = true;
    else if (argument === "--template") {
      options.template = args[++index];
      if (!options.template)
        throw new Error(
          "--template requires a template name or repository URL",
        );
    } else if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    else if (options.projectName)
      throw new Error("Only one project name may be provided");
    else options.projectName = argument;
  }

  if (!options.help && !options.projectName) {
    throw new Error(
      "Provide a project name, for example: npx create-streamfi-app my-streamfi-app",
    );
  }
  return options;
}

// Matches the env vars examples/nextjs-app (and the bundled template, which
// is a copy of it) actually read — see lib/conduit.ts. Values that can't be
// known ahead of time are left blank with a comment rather than guessed.
function testnetEnv(template) {
  if (template === "node-script" || template === "cron-worker") {
    const extra =
      template === "cron-worker"
        ? "\n# Recipient address to watch for auto-withdrawals.\nRECIPIENT_ADDRESS=\n"
        : "\n# Token address to stream (omit to use native XLM).\nTOKEN_ADDRESS=\n";
    return `# StreamFi / Stellar testnet
STREAM_NETWORK=testnet

# Deployed DripFactory contract ID for the chosen network.
FACTORY_ADDRESS=

# Secret key for signing transactions.
STELLAR_SECRET=${extra}`;
  }
  return `# StreamFi / Stellar testnet
NEXT_PUBLIC_NETWORK=testnet

# Deployed DripFactory contract ID for the chosen network. Required for
# list()/streamCount()/streamAddress() queries.
FACTORY_ADDRESS=

# Secret key for signing transactions. Required for creating/withdrawing streams.
# Deliberately NOT NEXT_PUBLIC_-prefixed; see lib/conduit.ts.
STELLAR_SECRET=

# Default address to query streams for (can also be typed in the UI).
NEXT_PUBLIC_ADDRESS=
`;
}

function run(command, args, options) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function scaffold(
  options,
  dependencies = { existsSync, writeFileSync, cpSync, resolve, run },
) {
  const targetDirectory = dependencies.resolve(
    process.cwd(),
    options.projectName,
  );
  if (dependencies.existsSync(targetDirectory)) {
    throw new Error(`The directory "${options.projectName}" already exists`);
  }

  // If --hooks is passed, use 'hooks' template; otherwise resolve built-in template names
  let templateName = options.template || "next-app";
  if (options.hooks) {
    templateName = "hooks";
  }

  const isBuiltIn =
    BUILT_IN_TEMPLATES.includes(templateName) || templateName === "hooks";
  const isGitUrl =
    !isBuiltIn &&
    Boolean(options.template) &&
    /^https?:\/\//.test(options.template);

  if (!isBuiltIn && !isGitUrl && options.template) {
    throw new Error(
      `Unknown template "${templateName}". Choose one of: ${BUILT_IN_TEMPLATES.join(", ")}, or pass a git URL.`,
    );
  }

  if (isGitUrl) {
    console.log(`Creating a StreamFi app in ${targetDirectory}...`);
    dependencies.run("git", [
      "clone",
      "--depth",
      "1",
      options.template,
      targetDirectory,
    ]);
  } else {
    const templateDir =
      templateName === "next-app"
        ? BUNDLED_TEMPLATE_DIR
        : dependencies.resolve(TEMPLATES_DIR, templateName);
    console.log(
      `Creating a StreamFi app in ${targetDirectory} (from the "${templateName}" template)...`,
    );
    dependencies.cpSync(templateDir, targetDirectory, { recursive: true });
  }

  const envPath = dependencies.resolve(targetDirectory, ".env.local");
  dependencies.writeFileSync(envPath, testnetEnv(templateName), "utf8");

  if (!options.skipInstall) {
    dependencies.run("npm", ["install"], { cwd: targetDirectory });
    // The bundled templates already declare @conduit-protocol/sdk as a
    // dependency; an external git-url starter generally won't.
    if (isGitUrl) {
      dependencies.run("npm", ["install", SDK_PACKAGE], {
        cwd: targetDirectory,
      });
    }
  }

  console.log("\nYour StreamFi app is ready!");
  console.log(`\n  cd ${basename(targetDirectory)}`);
  console.log(
    templateName === "next-app" || templateName === "hooks"
      ? "  npm run dev"
      : "  npm start",
  );
}

module.exports = {
  DEFAULT_TEMPLATE,
  BUNDLED_TEMPLATE_DIR,
  TEMPLATES_DIR,
  SDK_PACKAGE,
  BUILT_IN_TEMPLATES,
  parseArguments,
  scaffold,
  testnetEnv,
};
