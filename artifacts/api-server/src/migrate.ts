import { runTfMigrator } from "./lib/tf-migrator.js";

void runTfMigrator({
  args: process.argv.slice(2),
  env: process.env,
}).catch(() => {
  process.stderr.write("TF migration failed\n");
  process.exitCode = 1;
});
