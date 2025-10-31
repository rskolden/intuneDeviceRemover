#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { loadSerialNumbers, processSerials, exportData } from "./core.js";

// --- Parse CLI arguments ---
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : [])));

if (!args.connection || !args.csv || !args.column || !args.output) {
  console.log("Usage:");
  console.log("  node cli.js --connection <file.json> --csv <file.csv> --column <columnName> --output <folder> [--dry]");
  process.exit(1);
}

// --- Load connection info and serials ---
const connectInfo = JSON.parse(fs.readFileSync(args.connection, "utf8"));
const serials = await loadSerialNumbers(path.resolve(args.csv), args.column);
console.log(`Loaded ${serials.length} serials from ${args.csv}`);

// --- Run processing ---
const results = await processSerials(serials, connectInfo, !!args.dry, console.log);

if (!results || (!results.data?.length && !Array.isArray(results))) {
  console.error("⚠ No results to export.");
  process.exit(1);
}

// --- Determine output path ---
const timestamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 12); // YYYYMMDDHHmm

let outputFolder = args.output ? path.resolve(args.output) : process.cwd();
if (!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder, { recursive: true });

const baseName = args.dry ? "dryrun_results" : "results";
const outputFile = path.join(outputFolder, `${baseName}_${timestamp}.csv`);

// --- Write CSV ---
exportData(outputFile, results);

console.log(`✅ Results saved to: ${outputFile}`);
