import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import {
  facilityDestination,
  isPublicRoute,
  onboardingDestination,
  workspaceReturnTo,
} from "../src/lib/navigation";

test("internal work area, record and help links resolve to application routes", () => {
  const sourceRoot = new URL("../src/", import.meta.url);
  const app = readFileSync(new URL("App.tsx", sourceRoot), "utf8");
  const patterns = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map(
    ([, path]) => {
      if (path.includes("*?"))
        return new RegExp(`^${path.split("/*?")[0]}(?:/.*)?$`);
      return new RegExp(`^${path.replace(/:[^/]+/g, "[^/]+")}$`);
    },
  );
  const missing: string[] = [];
  let checked = 0;
  function scan(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = new URL(
        entry.name + (entry.isDirectory() ? "/" : ""),
        directory,
      );
      if (entry.isDirectory()) {
        scan(file);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = ts.createSourceFile(
        entry.name,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function visit(node: ts.Node) {
        let value: ts.Node | undefined;
        if (ts.isJsxAttribute(node) && node.name.getText(source) === "href") {
          value =
            node.initializer && ts.isJsxExpression(node.initializer)
              ? node.initializer.expression
              : node.initializer;
        } else if (
          ts.isPropertyAssignment(node) &&
          node.name.getText(source) === "href"
        ) {
          value = node.initializer;
        } else if (
          ts.isCallExpression(node) &&
          ["navigate", "setLocation"].includes(node.expression.getText(source))
        ) {
          value = node.arguments[0];
        }
        let target: string | undefined;
        if (
          value &&
          (ts.isStringLiteral(value) ||
            ts.isNoSubstitutionTemplateLiteral(value))
        )
          target = value.text;
        else if (value && ts.isTemplateExpression(value))
          target =
            value.head.text +
            value.templateSpans
              .map((span) => `record${span.literal.text}`)
              .join("");
        if (
          target?.startsWith("/") &&
          !target.startsWith("//") &&
          !target.startsWith("/api/")
        ) {
          const path = target.split(/[?#]/)[0];
          checked++;
          if (!patterns.some((pattern) => pattern.test(path)))
            missing.push(`${entry.name}: ${target}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan(sourceRoot);
  assert(
    checked > 100,
    "Audit must cover the application, not just top-level navigation",
  );
  assert.deepEqual(missing, []);
});

test("public entry points do not expose similarly named workspace routes", () => {
  for (const path of ["/", "/sign-in", "/sign-up", "/sign-in/factor-one"])
    assert.equal(isPublicRoute(path), true);
  for (const path of [
    "/dashboard",
    "/onboarding",
    "/sign-inventory",
    "/sign-other",
  ])
    assert.equal(isPublicRoute(path), false);
});

test("onboarding preserves a record destination, query and anchor", () => {
  const record = "/documents/42?tab=revisions#approval";
  const destination = onboardingDestination(record);
  const returnTo = new URL(
    destination,
    "https://cannaq.invalid",
  ).searchParams.get("returnTo");
  assert.equal(workspaceReturnTo(returnTo), record);
  assert.equal(onboardingDestination("/"), "/onboarding");
});

test("return destinations reject external redirects, auth loops and API routes", () => {
  for (const path of [
    null,
    "",
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/%2fexample.com",
    "/%5cexample.com",
    "/\n/example.com",
    "/%00",
    "/%zz",
    "/",
    "/sign-in",
    "/sign-up/verify",
    "/onboarding",
    "/onboarding/step",
    "/api/users",
    "/%61pi/users",
    "/documents/../sign-in",
  ]) {
    assert.equal(workspaceReturnTo(path), undefined, String(path));
  }
});

test("changing facilities exits a previous site's record and filters", () => {
  for (const [from, to] of [
    ["/batches/42?tab=release", "/batches"],
    ["/documents/42/revisions/3", "/documents"],
    ["/management-review/reviews/12", "/management-review"],
    ["/lots/99", "/inventory"],
    ["/inventory?lot=99", "/inventory"],
    ["/settings", "/settings"],
    ["/onboarding", "/dashboard"],
  ])
    assert.equal(facilityDestination(from), to);
});
