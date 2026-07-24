import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const generatedSchemaPath = path.resolve(
  packageDirectory,
  "..",
  "api-zod",
  "src",
  "generated",
  "api.ts",
);

function replaceOnce(source, search, replacement, label) {
  const occurrences = source.split(search).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Cannot enforce ${label}: expected one generated match, found ${occurrences}`,
    );
  }
  return source.replace(search, replacement);
}

let generated = await readFile(generatedSchemaPath, "utf8");

const requestStart = "export const SearchTracksBody = zod.object({";
const requestEnd = "\n});\n\nexport const searchTracksResponseSourcesMax";
const requestStartIndex = generated.indexOf(requestStart);
const requestEndIndex = generated.indexOf(
  requestEnd,
  requestStartIndex + requestStart.length,
);
if (requestStartIndex === -1 || requestEndIndex === -1) {
  throw new Error("Cannot locate the generated SearchTracksBody block");
}

let requestSchema = generated.slice(requestStartIndex, requestEndIndex);
requestSchema = replaceOnce(
  requestSchema,
  "  artist: zod\n    .string()",
  "  artist: zod\n    .string()\n    .trim()",
  "trimmed search artist",
);
requestSchema = replaceOnce(
  requestSchema,
  "  title: zod\n    .string()",
  "  title: zod\n    .string()\n    .trim()",
  "trimmed search title",
);
requestSchema = replaceOnce(
  requestSchema,
  "maxResults: zod.number()",
  "maxResults: zod\n    .number()\n    .int()",
  "integer search maxResults",
);
requestSchema = replaceOnce(
  requestSchema,
  `    .max(searchTracksBodySourcesMax)
    .optional(),`,
  `    .max(searchTracksBodySourcesMax)
    .refine((sources) => new Set(sources).size === sources.length, {
      message: "Sources must be unique",
    })
    .optional(),`,
  "unique request sources",
);
generated =
  generated.slice(0, requestStartIndex) +
  requestSchema +
  generated.slice(requestEndIndex);

generated = replaceOnce(
  generated,
  "    .max(searchTracksResponseSourcesMax),",
  `    .max(searchTracksResponseSourcesMax)
    .refine((sources) => new Set(sources).size === sources.length, {
      message: "Sources must be unique",
    }),`,
  "unique response sources",
);

await writeFile(generatedSchemaPath, generated, "utf8");
