#!/usr/bin/env node

const { parseArguments, scaffold } = require("../lib/scaffold");

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage: npx create-streamfi-app <project-name> [options]

Options:
  --template <name|url>  Starter to use: next-app, node-script, cron-worker, or a git URL to clone
  --hooks               Scaffold with @streamfi/react hooks instead of direct SDK usage
  --skip-install        Do not install dependencies
  --help                Show this message`);
      return;
    }

    await scaffold(options);
  } catch (error) {
    console.error(`\nUnable to create StreamFi app: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
