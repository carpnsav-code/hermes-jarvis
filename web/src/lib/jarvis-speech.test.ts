import { describe, expect, it } from "vitest";

import { extractSpeakable, sanitizeForSpeech } from "./jarvis-speech";

describe("sanitizeForSpeech", () => {
  it("strips markdown emphasis, headers, and inline code", () => {
    expect(sanitizeForSpeech("## Hello\n**bold** and `code` here")).toBe(
      "Hello bold and code here",
    );
  });

  it("replaces fenced code blocks with a spoken placeholder", () => {
    const out = sanitizeForSpeech("Look:\n```js\nconsole.log(1)\n```\ndone");
    expect(out).toContain("Code block omitted");
    expect(out).not.toContain("console.log");
  });

  it("speaks link text, not URLs", () => {
    expect(sanitizeForSpeech("see [the docs](https://x.dev/a)")).toBe(
      "see the docs",
    );
    expect(sanitizeForSpeech("go to https://example.com/x now")).toBe(
      "go to link now",
    );
  });
});

describe("extractSpeakable", () => {
  it("returns complete sentences and keeps the unfinished tail", () => {
    const { sentences, rest } = extractSpeakable(
      "Hello there. How are you? I am fin",
    );
    expect(sentences).toEqual(["Hello there.", "How are you?"]);
    expect(rest).toBe(" I am fin");
  });

  it("holds everything while inside an unclosed code fence", () => {
    const buf = "Here is code. ```js\nconst x = 1.\n";
    const { sentences, rest } = extractSpeakable(buf);
    expect(sentences).toEqual([]);
    expect(rest).toBe(buf);
  });

  it("releases the buffer once the fence closes", () => {
    const buf = "Intro.\n```js\nx = 1\n```\nAfter code. tail";
    const { sentences, rest } = extractSpeakable(buf);
    expect(sentences.join(" ")).toContain("After code.");
    expect(rest).toBe(" tail");
  });

  it("returns nothing for a boundary-free fragment", () => {
    const { sentences, rest } = extractSpeakable("streaming fragm");
    expect(sentences).toEqual([]);
    expect(rest).toBe("streaming fragm");
  });
});
