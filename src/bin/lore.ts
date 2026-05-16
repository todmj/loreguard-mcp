#!/usr/bin/env node
import { main } from "../cli/index.js";

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `lore: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
