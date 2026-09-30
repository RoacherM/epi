import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// A minimal YAML reader for GitHub Actions workflow files only (mappings, block lists, `|` block
// scalars, plain/quoted scalars). Not a general YAML parser: there is no `yaml`/`js-yaml` package
// available to add in this sandboxed worktree (only `npm view` is allowed, not `npm install` -- see
// AGENTS.md's Setup section), and the three files below are written by hand to stay inside this
// subset (no flow style, no anchors). It's exercised directly against those three files, so a
// structural mistake in one of them (bad indent, an unclosed block scalar) fails here, not on push.
function parseYaml(text) {
  const lines = text.split("\n").filter((line) => !/^\s*#/.test(line) && line.trim() !== "");
  let index = 0;

  function indentOf(line) {
    return line.length - line.trimStart().length;
  }

  function stripQuotes(value) {
    const trimmed = value.trim();
    if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
    return trimmed;
  }

  function parseBlockScalar(indent) {
    const collected = [];
    while (index < lines.length && (indentOf(lines[index]) > indent || lines[index].trim() === "")) {
      collected.push(lines[index].slice(indent + 2));
      index += 1;
    }
    return collected.join("\n");
  }

  function parseMapping(indent) {
    const result = {};
    while (index < lines.length && indentOf(lines[index]) === indent && !/^\s*-(\s|$)/.test(lines[index])) {
      const line = lines[index];
      const colon = line.indexOf(": ");
      const isBareKey = colon === -1 && line.trim().endsWith(":");
      const key = stripQuotes(isBareKey ? line.trim().slice(0, -1) : line.slice(0, colon).trim());
      const rest = isBareKey ? "" : line.slice(colon + 1).trim();
      index += 1;
      if (rest === "|" || rest === "|-" || rest === ">") {
        result[key] = parseBlockScalar(indent);
      } else if (rest !== "") {
        result[key] = stripQuotes(rest);
      } else if (index < lines.length && indentOf(lines[index]) > indent) {
        result[key] = parseNode(indentOf(lines[index]));
      } else {
        result[key] = null;
      }
    }
    return result;
  }

  function parseList(indent) {
    const result = [];
    while (index < lines.length && indentOf(lines[index]) === indent && /^\s*-(\s|$)/.test(lines[index])) {
      const line = lines[index];
      const afterDash = line.slice(indent + 1).replace(/^\s+/, "");
      const itemIndent = indent + (line.slice(indent + 1).match(/^\s*/)[0].length + 1);
      const looksLikeMappingKey = /^[^:]+:(\s|$)/.test(afterDash);
      if (afterDash === "" || !looksLikeMappingKey) {
        index += 1;
        result.push(afterDash === "" ? parseNode(itemIndent) : stripQuotes(afterDash));
        continue;
      }
      // "- key: value" (or "- key:" starting a nested mapping) -- rewrite as a plain mapping line
      // at itemIndent and let parseMapping take over from here.
      lines[index] = " ".repeat(itemIndent) + afterDash;
      result.push(parseMapping(itemIndent));
    }
    return result;
  }

  function parseNode(indent) {
    if (index < lines.length && indentOf(lines[index]) === indent && /^\s*-(\s|$)/.test(lines[index])) {
      return parseList(indent);
    }
    return parseMapping(indent);
  }

  return parseNode(0);
}

function loadWorkflow(name) {
  const path = new URL(`../.github/workflows/${name}`, import.meta.url);
  const text = readFileSync(path, "utf8");
  return { text, doc: parseYaml(text) };
}

function stepRuns(job) {
  return (job.steps ?? []).filter((step) => typeof step.run === "string").map((step) => step.run);
}

test("ci.yml parses and runs build, the dist check, and the tests", () => {
  const { doc, text } = loadWorkflow("ci.yml");
  assert.ok(doc.on !== undefined && "push" in doc.on && "pull_request" in doc.on);
  assert.equal(doc.permissions.contents, "read");
  const runs = stepRuns(doc.jobs.test).join("\n");
  assert.match(runs, /npm ci/);
  assert.match(runs, /npm run build/);
  assert.match(runs, /git diff --exit-code.*dist/);
  assert.match(runs, /npm test/);
  assert.match(text, /node-version-file: package\.json/);
});

test("pi-upgrade.yml parses, runs the gate, and branches on the result", () => {
  const { doc, text } = loadWorkflow("pi-upgrade.yml");
  assert.ok("schedule" in doc.on && "workflow_dispatch" in doc.on);
  assert.equal(doc.permissions["pull-requests"], "write");
  assert.equal(doc.permissions.issues, "write");
  const job = doc.jobs.upgrade;
  const runs = stepRuns(job).join("\n");
  assert.match(runs, /npm run pi:upgrade -- --report report\.md/);
  assert.match(runs, /gh pr create|gh pr edit/);
  assert.match(runs, /gh issue create|gh issue comment/);
  assert.match(runs, /model-visible-change/);
  assert.match(text, /GITHUB_TOKEN.*does not trigger other workflows/s);
});

test("release.yml parses and runs the release script on push to main", () => {
  const { doc } = loadWorkflow("release.yml");
  assert.deepEqual(doc.on.push.branches, ["main"]);
  assert.equal(doc.permissions.contents, "write");
  const runs = stepRuns(doc.jobs.release).join("\n");
  assert.match(runs, /npm run build/);
  assert.match(runs, /npm run release/);
});

test("every workflow declares minimal, explicit permissions (no default write-all)", () => {
  for (const name of ["ci.yml", "pi-upgrade.yml", "release.yml"]) {
    const { doc } = loadWorkflow(name);
    assert.ok(doc.permissions !== undefined, `${name} must declare permissions`);
  }
});
