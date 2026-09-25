import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { apiErrorMessage } from "../packages/admin-web/src/api";
import { getTranslation } from "../packages/admin-web/src/i18n";
import { messages as zh } from "../packages/admin-web/src/locales/zh-CN";
import { messages as en } from "../packages/admin-web/src/locales/en-US";

test("locale resources use matching semantic keys and parameters", () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys);

  for (const key of zhKeys) {
    assert.match(key, /^[a-z][\w]*(?:\.[a-z][\w]*)+$/i);
    assert.doesNotMatch(key, /[\u3400-\u9fff]/);
    const parameters = (value: string) => [...value.matchAll(/\{([a-zA-Z]\w*)\}/g)]
      .map((match) => match[1]).sort();
    assert.deepEqual(parameters(en[key as keyof typeof en]), parameters(zh[key as keyof typeof zh]), key);
  }
});

test("semantic keys interpolate parameters in both languages", () => {
  assert.equal(getTranslation("app.deleteUserName", "zh-CN", { name: "alice" }), "删除用户 alice？");
  assert.equal(getTranslation("app.deleteUserName", "en-US", { name: "alice" }), "Delete user alice?");
});

test("API failures are localized instead of displaying backend English", () => {
  assert.equal(apiErrorMessage(401, { error: "invalid_credentials" }, "zh-CN"), "账号或密码错误");
  assert.equal(apiErrorMessage(409, { error: "username already exists" }, "zh-CN"), "用户名已存在");
  assert.equal(apiErrorMessage(500, { error: "internal server error" }, "zh-CN"), "服务器处理失败，请稍后重试");
  assert.equal(apiErrorMessage(401, { error: "invalid_credentials" }, "en-US"), "Incorrect username or password");
});

test("HTML entry defaults to Chinese before the app loads", () => {
  const html = readFileSync(new URL("../packages/admin-web/index.html", import.meta.url), "utf8");
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>MCP 控制台<\/title>/);
});

test("frontend JSX has no untranslated display copy", () => {
  const root = new URL("../packages/admin-web/src/", import.meta.url).pathname;
  const files = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
    const file = join(directory, name);
    return statSync(file).isDirectory() ? files(file) : file.endsWith(".tsx") && !file.includes("/locales/") ? [file] : [];
  });
  const allowedText = new Set(["⌘ K", "ESC", "/mcp/", "PostgreSQL · Redis · OAuth 2.1"]);
  const displayedAttributes = new Set(["eyebrow", "subtitle", "label", "placeholder", "checkedChildren", "unCheckedChildren", "title", "description", "message", "okText", "cancelText", "aria-label"]);
  const allowedAttribute = /^(?:https?:\/\/|external-search$|read write$|PostgreSQL$|Redis$|[a-z][\w]*\.[a-zA-Z][\w.]*)/;
  const untranslated: string[] = [];
  for (const file of files(root)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        const copy = node.getText(source).trim();
        if (/[A-Za-z\u3400-\u9fff]/.test(copy) && !allowedText.has(copy)) untranslated.push(`${file}: ${copy}`);
      }
      if (ts.isJsxAttribute(node) && displayedAttributes.has(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const copy = node.initializer.text;
        if (/[A-Za-z\u3400-\u9fff]/.test(copy) && !allowedAttribute.test(copy)) untranslated.push(`${file}: ${node.name.getText(source)}=${copy}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(untranslated, []);
});
