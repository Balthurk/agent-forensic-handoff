#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(root, "skills", "agent-forensic-handoff");
const skillPath = path.join(skillRoot, "SKILL.md");
const agentPath = path.join(skillRoot, "agents", "openai.yaml");
const errors = [];

if (!fs.existsSync(skillPath)) errors.push("SKILL.md is missing");
if (!fs.existsSync(agentPath)) errors.push("agents/openai.yaml is missing");

if (!errors.length) {
  const skill = fs.readFileSync(skillPath, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill)?.[1] ?? "";
  const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  if (name !== "agent-forensic-handoff") errors.push(`unexpected skill name: ${name || "missing"}`);
  if (!description || description.length < 40 || description.length > 1024) errors.push("description must be 40-1024 characters");
  if (/TODO|\[TODO/i.test(skill)) errors.push("SKILL.md contains TODO text");
  for (const match of skill.matchAll(/\]\((references\/[^)]+)\)/g)) {
    if (!fs.existsSync(path.join(skillRoot, match[1]))) errors.push(`missing referenced file: ${match[1]}`);
  }

  const agent = fs.readFileSync(agentPath, "utf8");
  const short = /^\s*short_description:\s*["']?(.+?)["']?\s*$/m.exec(agent)?.[1] ?? "";
  const prompt = /^\s*default_prompt:\s*["']?(.+?)["']?\s*$/m.exec(agent)?.[1] ?? "";
  if (short.length < 25 || short.length > 64) errors.push("short_description must be 25-64 characters");
  if (!prompt.includes("$agent-forensic-handoff")) errors.push("default_prompt must mention $agent-forensic-handoff");
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`ERROR: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Skill validation passed: agent-forensic-handoff\n");
}
