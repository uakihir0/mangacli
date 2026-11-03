// schema.json（エディタ向けの JSON Schema）を生成する。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../src/fonts/catalog.ts";
import { jsonSchema } from "../src/schema/jsonschema.ts";

writeFileSync(join(PACKAGE_ROOT, "schema.json"), JSON.stringify(jsonSchema(), null, 2) + "\n");
console.log("schema.json written");
