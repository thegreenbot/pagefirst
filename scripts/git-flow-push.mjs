import { stdin } from "node:process";
import { checkPushLine } from "./git-flow.mjs";

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString("utf8");
const failures = [];
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  const result = checkPushLine(line);
  if (!result.ok) failures.push(result.message);
}
if (failures.length > 0) {
  for (const message of failures) {
    process.stderr.write(`git-flow: ${message}\n`);
  }
  process.exit(1);
}
