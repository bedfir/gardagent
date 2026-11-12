#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "./command.js";

const result = run(process.argv.slice(2), (path) => readFileSync(path, "utf8"));
process.stdout.write(result.output + "\n");
process.exitCode = result.code;
