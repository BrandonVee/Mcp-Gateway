import assert from "node:assert/strict";
import { test } from "node:test";
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
