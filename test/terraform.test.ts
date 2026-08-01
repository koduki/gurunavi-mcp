import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface HclParser {
  parseToObject(input: string): unknown;
}

const require = createRequire(import.meta.url);
const hcl = require("hcl2-parser") as HclParser;

describe("Terraform configuration", () => {
  it("is syntactically valid HCL2", async () => {
    const directory = new URL("../infra/terraform/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".tf")).sort();

    expect(files).toEqual(["main.tf", "outputs.tf", "variables.tf", "versions.tf"]);
    for (const file of files) {
      const source = await readFile(new URL(file, directory), "utf8");
      expect(() => hcl.parseToObject(source), file).not.toThrow();
    }
  });
});
